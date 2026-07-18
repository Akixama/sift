import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, Copy, Check, ExternalLink, Loader2 } from "lucide-react";
import { createWalletClient, custom, parseAbi, defineChain } from "viem";

// ---------- Chain config ----------
const CHAINS = {
  monad: { label: "Monad", moralisChain: "0x8f" },
  ethereum: { label: "Ethereum", moralisChain: "0x1" },
  base: { label: "Base", moralisChain: "0x2105" },
  // Robinhood Chain (mainnet chain id 4663 / 0x1237) is indexed by Blockscout, not
  // Moralis, so it's routed to the Blockscout adapter below instead of the Moralis one.
  robinhood: { label: "Robinhood", moralisChain: "0x1237" },
};
const DEFAULT_CHAIN = "monad";

// ---------- Onchain scan log (Monad Testnet) ----------
// Every verdict gets an optional permanent record on Monad via the ScanRegistry
// contract, so a "Looks clean." isn't just a UI toast that vanishes on refresh — it's
// a checkable, timestamped log entry anyone can pull up on the explorer.
const monadTestnetChain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadvision.com" } },
});

const SCAN_REGISTRY_ADDRESS = import.meta.env?.VITE_SCAN_REGISTRY_ADDRESS || "0xd9145CCE52D386f254917e481eB44e9943F39138";
const SCAN_REGISTRY_ABI = parseAbi([
  "function logScan(address token, uint8 tier, uint16 topHolderPct, uint32 totalHolders) returns (uint256)",
]);
const TIER_TO_ENUM = { clear: 0, caution: 1, risk: 2 };

async function logScanOnchain(result) {
  if (!window.ethereum) throw new Error("No wallet found — install MetaMask to log a scan onchain.");
  const client = createWalletClient({ chain: monadTestnetChain, transport: custom(window.ethereum) });
  const [account] = await client.requestAddresses();
  const hash = await client.writeContract({
    account,
    address: SCAN_REGISTRY_ADDRESS,
    abi: SCAN_REGISTRY_ABI,
    functionName: "logScan",
    args: [
      result.address,
      TIER_TO_ENUM[result.tier] ?? 0,
      Math.round((result.topHolderPct ?? 0) * 10),
      result.totalHolders ?? 0,
    ],
  });
  return hash;
}

// Which data provider each chain uses. Anything not listed here falls back to Moralis.
const PROVIDER_BY_CHAIN = {
  robinhood: "blockscout",
};

// ---------- Moralis (top holders, total holder count, sniper + bundler detection) ----------
// Get a free key at moralis.io -> API Keys, then set it in .env as:
//   VITE_MORALIS_API_KEY=your_key_here
const MORALIS_API_BASE = "https://deep-index.moralis.io/api/v2.2";
const MORALIS_API_KEY = import.meta.env?.VITE_MORALIS_API_KEY || "";
const SNIPER_BLOCK_WINDOW = 2; // buys within this many blocks of launch count as "sniped"
// NOTE: block times vary a lot by chain (Monad ~0.4s, Base ~2s, Ethereum ~12s), so a
// fixed block-count window means "sniped" maps to a different real-world time span per
// chain. Fine for a hackathon MVP.

async function moralisFetch(chainKey, path, params = {}) {
  const qs = new URLSearchParams({ chain: CHAINS[chainKey].moralisChain, ...params });
  const res = await fetch(`${MORALIS_API_BASE}${path}?${qs.toString()}`, {
    headers: { "X-API-Key": MORALIS_API_KEY },
  });
  if (!res.ok) throw new Error(`Moralis request failed (${res.status}) — check your key`);
  return res.json();
}

// Fetch a buffer of 15 so that after filtering out the LP pair address(es), we still
// have a real top 10 of actual wallets left.
async function getTopHolders(chainKey, address, pairAddressSet, limit = 15) {
  const data = await moralisFetch(chainKey, `/erc20/${address}/owners`, { order: "DESC", limit: String(limit) });
  const owners = Array.isArray(data?.result) ? data.result : [];
  return owners
    .filter((o) => !pairAddressSet.has(o.owner_address?.toLowerCase()))
    .slice(0, 10)
    .map((o) => ({
      address: o.owner_address,
      pct: Number(o.percentage_relative_to_total_supply || 0),
    }));
}

// Real total holder count — separate endpoint from /owners, which does NOT return a total.
async function getTotalHolders(chainKey, address) {
  const data = await moralisFetch(chainKey, `/erc20/${address}/holders`, {});
  const total = data?.totalHolders;
  return typeof total === "number" ? total : Number(total) || null;
}

async function getEarlyTransfers(chainKey, address, limit = 100) {
  const data = await moralisFetch(chainKey, `/erc20/${address}/transfers`, { order: "ASC", limit: String(limit) });
  const transfers = Array.isArray(data?.result) ? data.result : [];
  return transfers
    .map((t) => ({
      to: t.to_address?.toLowerCase(),
      from: t.from_address?.toLowerCase(),
      block: Number(t.block_number),
      timestamp: t.block_timestamp,
    }))
    .filter((t) => t.to && !Number.isNaN(t.block));
}

// ---------- Trading pairs (used for LP filtering + market cap + ATH) ----------
async function getPairs(chainKey, address) {
  const pairsData = await moralisFetch(chainKey, `/erc20/${address}/pairs`, {});
  const pairs = Array.isArray(pairsData?.pairs) ? pairsData.pairs : [];
  const pairAddressSet = new Set(pairs.map((p) => p.pair_address?.toLowerCase()).filter(Boolean));
  const bestPair = pairs.length ? pairs.reduce((a, b) => (Number(b.liquidity_usd) > Number(a.liquidity_usd) ? b : a)) : null;
  return { pairs, pairAddressSet, bestPair };
}

// ---------- Market cap + ATH ----------
const DEXSCREENER_CHAIN_IDS = { monad: "monad", ethereum: "ethereum", base: "base" };

// DexScreener's public API (no key needed) computes marketCap and fdv itself, using
// whatever circulating-supply source they trust — this matches what people actually
// see on dexscreener.com, which our own on-chain total_supply math can't always
// reproduce (e.g. tokens with non-standard or cross-chain supply mechanics).
// Current endpoint: /tokens/v1/{chainId}/{tokenAddress} — returns a plain array of
// pairs directly (the older /latest/dex/tokens/{address} endpoint is deprecated and
// returns a different, unreliable shape).
async function getDexScreenerMarketData(chainKey, address) {
  const wantedChain = DEXSCREENER_CHAIN_IDS[chainKey];
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${wantedChain}/${address}`);
  if (!res.ok) return null;
  const pairs = await res.json();
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const best = pairs.reduce((a, b) => (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a));
  const priceUsd = Number(best.priceUsd);
  const marketCap = best.marketCap != null ? Number(best.marketCap) : null;
  if (!priceUsd || marketCap == null) return null;
  // Implied circulating supply DexScreener is using, so we can scale a historical ATH
  // price the same way (rather than guessing at supply ourselves).
  const impliedSupply = marketCap / priceUsd;

  const websites = best.info?.websites?.map((w) => w.url).filter(Boolean) || [];
  const socials = best.info?.socials?.map((s) => ({ platform: s.platform, handle: s.handle })).filter((s) => s.platform) || [];
  // Age uses the EARLIEST pool we know about, not just the highest-liquidity one —
  // a token can have an old pool that's since been eclipsed in depth by a newer one
  // (migrations, new listings, arb pools), and "pool age" should reflect how long
  // this token has actually had a market, not just how old the current deepest pool is.
  const poolCreationTimestamps = pairs.map((p) => p.pairCreatedAt).filter((t) => typeof t === "number" && t > 0);
  const earliestPoolCreatedAt = poolCreationTimestamps.length ? Math.min(...poolCreationTimestamps) : null;
  const poolAgeDays = earliestPoolCreatedAt ? Math.floor((Date.now() - earliestPoolCreatedAt) / (1000 * 60 * 60 * 24)) : null;
  const liquidityUsd = best.liquidity?.usd != null ? Number(best.liquidity.usd) : null;

  return { marketCap, impliedSupply, websites, socials, poolAgeDays, liquidityUsd, priceUsd, pairAddress: best.pairAddress || null };
}

async function getTokenMetaAndPrice(chainKey, address) {
  const [metaData, priceData] = await Promise.all([
    moralisFetch(chainKey, `/erc20/metadata`, { "addresses[0]": address }),
    moralisFetch(chainKey, `/erc20/${address}/price`, {}),
  ]);
  const meta = Array.isArray(metaData) ? metaData[0] : null;
  const usdPrice = Number(priceData?.usdPrice) || null;
  const decimals = Number(meta?.decimals ?? 18);
  const rawSupply = meta?.total_supply;
  const supply = rawSupply ? Number(rawSupply) / Math.pow(10, decimals) : null;
  return { usdPrice, supply };
}

// Up to ~1000 daily candles on a given pair. Callers should pass whichever pair
// address is actually backing the current price/market cap figure — using a
// different (Moralis-picked) pair here risks pulling a wild "high" from a thinly
// traded pool that has nothing to do with the price anyone actually sees.
async function getCandles(chainKey, pairAddress) {
  if (!pairAddress) return [];
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ohlcv = await moralisFetch(chainKey, `/pairs/${pairAddress}/ohlcv`, {
    timeframe: "1d",
    currency: "usd",
    fromDate,
    toDate,
  });
  return Array.isArray(ohlcv?.result) ? ohlcv.result : [];
}

// Approximate ATH market cap = highest reliable daily "high" * circulating supply.
// `supply` should be the same circulating-supply basis used for current market cap
// (DexScreener's implied supply when available, otherwise Moralis on-chain total
// supply as a fallback) so ATH and current market cap are apples-to-apples.
// Candles with very few trades are excluded first — on thin-liquidity pools, a single
// small trade can spike the recorded "high" for one candle to something unrealistic
// even though no real volume traded there. Falls back to the unfiltered set only if
// every candle looks thin (better an estimate than nothing).
function computeAth(candles, supply) {
  if (!candles.length || !supply) return null;
  const reliable = candles.filter((c) => Number(c.trades) >= 3);
  const pool = reliable.length ? reliable : candles;
  const athCandle = pool.reduce((a, b) => (Number(b.high) > Number(a.high) ? b : a));
  return { marketCap: Number(athCandle.high) * supply, date: athCandle.timestamp?.slice(0, 10) || null };
}

async function analyzeHolders(chainKey, address, pairAddressSet, candles, supply) {
  const [holders, totalHolders, transfers] = await Promise.all([
    getTopHolders(chainKey, address, pairAddressSet),
    getTotalHolders(chainKey, address).catch(() => null),
    getEarlyTransfers(chainKey, address, 100),
  ]);

  const totalPct = Math.round(holders.reduce((sum, h) => sum + h.pct, 0) * 10) / 10;

  // How many distinct wallets each top holder has sent this token to (recent activity
  // sample — not guaranteed full lifetime history for high-volume tokens).
  const sentSetsByAddress = {};
  transfers.forEach((t) => {
    if (!t.from) return;
    (sentSetsByAddress[t.from] ||= new Set()).add(t.to);
  });
  const withSentCounts = (list) =>
    list.map((h) => {
      const key = h.address?.toLowerCase();
      const set = key ? sentSetsByAddress[key] : null;
      set?.delete(key); // don't count sending to self
      return { ...h, sentToCount: set ? set.size : 0 };
    });

  if (!transfers.length) {
    return {
      holders: withSentCounts(holders).map((h) => ({ ...h, isSniper: null, isBundled: false })),
      totalHolders,
      totalPct,
      launchBlock: null,
      bundledGroups: [],
    };
  }

  const launchBlock = Math.min(...transfers.map((t) => t.block));
  const firstBlockByAddress = {};
  transfers.forEach((t) => {
    if (!(t.to in firstBlockByAddress) || t.block < firstBlockByAddress[t.to]) {
      firstBlockByAddress[t.to] = t.block;
    }
  });

  const enriched = withSentCounts(holders).map((h) => {
    const key = h.address?.toLowerCase();
    const firstBlock = key in firstBlockByAddress ? firstBlockByAddress[key] : null;
    const isSniper = firstBlock !== null ? firstBlock - launchBlock <= SNIPER_BLOCK_WINDOW : null;
    return { ...h, firstBlock, isSniper };
  });

  const blockGroups = {};
  enriched.forEach((h) => {
    if (h.firstBlock === null) return;
    (blockGroups[h.firstBlock] ||= []).push(h.address);
  });
  const bundledGroups = Object.entries(blockGroups)
    .filter(([, addrs]) => addrs.length >= 2)
    .map(([block, addrs]) => ({ block: Number(block), addresses: addrs }));
  const bundledSet = new Set(bundledGroups.flatMap((g) => g.addresses));

  const final = enriched.map((h) => ({ ...h, isBundled: bundledSet.has(h.address) }));
  return { holders: final, totalHolders, totalPct, launchBlock, bundledGroups };
}

// =====================================================================================
// ---------- Blockscout adapter (Robinhood chain) ----------
// Robinhood Chain (mainnet chain id 4663) is indexed by Blockscout as its official
// explorer, and Moralis doesn't cover it. Blockscout's data model is different enough
// from Moralis that this is a parallel adapter rather than a drop-in swap:
//   - No /pairs endpoint, so we can't identify and exclude the LP pool address from
//     the top-holders list the way we do on the Moralis-backed chains. On a brand-new
//     chain the #1 "holder" is very often the pool itself, so we surface this as a
//     caveat in the verdict copy instead of silently mislabeling a pool as a whale.
//   - No historical OHLCV endpoint, so ATH market cap is unavailable here (same
//     "Unavailable" state the UI already shows when data is genuinely missing).
//   - Launch block comes from the token contract's *creation transaction*, which is
//     more precise than the Moralis path's "earliest block among the first 100
//     transfers we happened to fetch" heuristic.
//   - This calls Robinhood Chain's own public Blockscout instance directly
//     (robinhoodchain.blockscout.com/api/v2), not the api.blockscout.com "Pro API"
//     aggregator. The Pro API is a paid, server-side product: it 402s without a paid
//     key, and even with one it doesn't send Access-Control-Allow-Origin, so a browser
//     calling it directly gets blocked by CORS before the 402 even matters. The
//     per-chain public instance is a normal explorer API meant for direct browser use
//     and needs no key for the endpoints this adapter uses.
//   - If you outgrow the public instance's rate limits later, the Pro API is still an
//     option, but only via your own backend (key stays server-side, your server
//     forwards the response, so CORS is a non-issue).
// =====================================================================================
const BLOCKSCOUT_API_BASE = import.meta.env?.VITE_BLOCKSCOUT_API_BASE || "https://robinhoodchain.blockscout.com/api/v2";
const BLOCKSCOUT_API_KEY = import.meta.env?.VITE_BLOCKSCOUT_API_KEY || ""; // only used if you switch BASE to a key-gated instance
// How many transfer pages (oldest-going) to walk when hunting for the launch-block
// snipers/bundlers. Each extra page is a sequential round-trip (Blockscout's
// next_page_params can't be parallelized), so this defaults low for hackathon-demo
// speed. Bump it via env if a token has enough volume that sniper detection needs to
// look further back than the most recent page.
const BLOCKSCOUT_MAX_TRANSFER_PAGES = Number(import.meta.env?.VITE_BLOCKSCOUT_MAX_TRANSFER_PAGES) || 1;

async function blockscoutFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  if (BLOCKSCOUT_API_KEY) qs.set("apikey", BLOCKSCOUT_API_KEY);
  const query = qs.toString();
  const res = await fetch(`${BLOCKSCOUT_API_BASE}${path}${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(`Blockscout request failed (${res.status}) — check the address or your API key`);
  return res.json();
}

// GET /tokens/{address} — metadata, holder count, and (when available) exchange rate
// and circulating market cap computed by Blockscout itself.
async function getBlockscoutTokenInfo(address) {
  const data = await blockscoutFetch(`/tokens/${address}`);
  return {
    decimals: Number(data?.decimals ?? 18),
    totalSupplyRaw: data?.total_supply ?? null, // raw base-unit string
    holdersCount: data?.holders_count != null ? Number(data.holders_count) : null,
    priceUsd: data?.exchange_rate != null ? Number(data.exchange_rate) : null,
    circulatingMarketCap: data?.circulating_market_cap != null ? Number(data.circulating_market_cap) : null,
  };
}

// GET /tokens/{address}/holders — first page only (Blockscout's default page size is
// plenty for a top-10-plus-buffer view). No pair address to filter out here — see the
// caveat at the top of this section.
// Returns raw base-unit values (no pct yet) so this can be fetched in parallel with
// getBlockscoutTokenInfo instead of waiting on it for totalSupplyRaw first.
async function getBlockscoutTopHoldersRaw(address, limit = 15) {
  const data = await blockscoutFetch(`/tokens/${address}/holders`);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.slice(0, limit).map((h) => ({
    address: h.address?.hash,
    raw: Number(h.value || 0),
  }));
}

// GET /addresses/{address} -> creation_transaction_hash -> GET /transactions/{hash}.
// This is the token contract's deployment block, i.e. the real launch block.
async function getBlockscoutLaunchBlock(address) {
  try {
    const addrData = await blockscoutFetch(`/addresses/${address}`);
    const creationHash = addrData?.creation_transaction_hash || addrData?.creation_tx_hash;
    if (!creationHash) return null;
    const txData = await blockscoutFetch(`/transactions/${creationHash}`);
    const block = txData?.block ?? txData?.block_number;
    return Number(block) || null;
  } catch {
    return null;
  }
}

// GET /tokens/{address}/counters — cheap, dedicated endpoint for the real total
// transfer count (transfers_count) and holder count (token_holders_count). We already
// get holders from /tokens/{address}, but this is the only place transfers_count lives.
async function getBlockscoutTokenCounters(address) {
  const data = await blockscoutFetch(`/tokens/${address}/counters`);
  return {
    transfersCount: data?.transfers_count != null ? Number(data.transfers_count) : null,
  };
}

// GET /tokens/{address}/transfers, walked backwards via next_page_params for a few
// pages so sniper/bundle detection has a shot at reaching the launch-block buys.
async function getBlockscoutTransfers(address, maxPages = BLOCKSCOUT_MAX_TRANSFER_PAGES) {
  let items = [];
  let pageParams = {};
  for (let i = 0; i < maxPages; i++) {
    const data = await blockscoutFetch(`/tokens/${address}/transfers`, pageParams);
    const pageItems = Array.isArray(data?.items) ? data.items : [];
    items = items.concat(pageItems);
    if (!data?.next_page_params) break;
    pageParams = data.next_page_params;
  }
  return items
    .map((t) => ({
      to: t.to?.hash?.toLowerCase(),
      from: t.from?.hash?.toLowerCase(),
      block: Number(t.block_number ?? t.block),
    }))
    .filter((t) => t.to && !Number.isNaN(t.block));
}

function buildHolderAnalysisBlockscout(rawHolders, totalSupplyRaw, totalHolders, launchBlockFromCreation, transfers) {
  const totalSupply = totalSupplyRaw ? Number(totalSupplyRaw) : null;
  const holders = rawHolders
    .map((h) => ({
      address: h.address,
      pct: Math.round((totalSupply ? (h.raw / totalSupply) * 100 : 0) * 10) / 10,
    }))
    .slice(0, 10);

  const totalPct = Math.round(holders.reduce((sum, h) => sum + h.pct, 0) * 10) / 10;

  const sentSetsByAddress = {};
  transfers.forEach((t) => {
    if (!t.from) return;
    (sentSetsByAddress[t.from] ||= new Set()).add(t.to);
  });
  const withSentCounts = (list) =>
    list.map((h) => {
      const key = h.address?.toLowerCase();
      const set = key ? sentSetsByAddress[key] : null;
      set?.delete(key);
      return { ...h, sentToCount: set ? set.size : 0 };
    });

  // Prefer the contract-creation block as ground truth; fall back to the earliest
  // block seen in the transfer pages we managed to walk if creation lookup failed.
  const launchBlock = launchBlockFromCreation ?? (transfers.length ? Math.min(...transfers.map((t) => t.block)) : null);

  if (launchBlock === null) {
    return {
      holders: withSentCounts(holders).map((h) => ({ ...h, isSniper: null, isBundled: false })),
      totalHolders,
      totalPct,
      launchBlock: null,
      bundledGroups: [],
    };
  }

  const firstBlockByAddress = {};
  transfers.forEach((t) => {
    if (!(t.to in firstBlockByAddress) || t.block < firstBlockByAddress[t.to]) {
      firstBlockByAddress[t.to] = t.block;
    }
  });

  const enriched = withSentCounts(holders).map((h) => {
    const key = h.address?.toLowerCase();
    const firstBlock = key in firstBlockByAddress ? firstBlockByAddress[key] : null;
    const isSniper = firstBlock !== null ? firstBlock - launchBlock <= SNIPER_BLOCK_WINDOW : null;
    return { ...h, firstBlock, isSniper };
  });

  const blockGroups = {};
  enriched.forEach((h) => {
    if (h.firstBlock === null) return;
    (blockGroups[h.firstBlock] ||= []).push(h.address);
  });
  const bundledGroups = Object.entries(blockGroups)
    .filter(([, addrs]) => addrs.length >= 2)
    .map(([block, addrs]) => ({ block: Number(block), addresses: addrs }));
  const bundledSet = new Set(bundledGroups.flatMap((g) => g.addresses));

  const final = enriched.map((h) => ({ ...h, isBundled: bundledSet.has(h.address) }));
  return { holders: final, totalHolders, totalPct, launchBlock, bundledGroups };
}

async function analyzeBlockscout(address, chainKey) {
  // Run token info in parallel with the holder/transfer/launch-block work instead of
  // awaiting it first — the pct math only needs info.totalSupplyRaw once everything
  // resolves, so there's no reason to pay for that round-trip serially.
  const [rawHolders, launchBlockFromCreation, transfers, info, counters] = await Promise.all([
    getBlockscoutTopHoldersRaw(address).catch(() => []),
    getBlockscoutLaunchBlock(address).catch(() => null),
    getBlockscoutTransfers(address).catch(() => []),
    getBlockscoutTokenInfo(address),
    getBlockscoutTokenCounters(address).catch(() => ({ transfersCount: null })),
  ]);
  const holderData = buildHolderAnalysisBlockscout(rawHolders, info.totalSupplyRaw, info.holdersCount, launchBlockFromCreation, transfers);

  const totalHolders = holderData ? holderData.totalHolders : info.holdersCount;
  const holders = holderData ? holderData.holders : [];
  const topHolderPct = holderData ? holderData.totalPct : null;
  const sniperCount = holders.filter((h) => h.isSniper === true).length;
  const bundledCount = holders.filter((h) => h.isBundled).length;

  let flags = 0;
  if (topHolderPct !== null && topHolderPct > 40) flags++;
  if (sniperCount >= 2) flags++;
  if (bundledCount >= 2) flags++;

  let tier = "clear";
  if (flags >= 3) tier = "risk";
  else if (flags >= 1) tier = "caution";

  const reasonsGood = [];
  const reasonsBad = [];
  if (topHolderPct !== null) {
    if (topHolderPct <= 40) reasonsGood.push(`top 10 wallets hold ${topHolderPct}%`);
    else reasonsBad.push(`top 10 wallets hold ${topHolderPct}%`);
  }
  if (sniperCount > 0) reasonsBad.push(`${sniperCount} of the top 10 holders bought at the launch block`);
  if (bundledCount > 0) reasonsBad.push(`${bundledCount} top holders bought in the same bundled block`);

  const headline =
    reasonsGood.length === 0 && reasonsBad.length === 0
      ? "Not enough data yet."
      : tier === "clear"
      ? "Looks clean."
      : tier === "caution"
      ? "Worth a second look."
      : "Proceed carefully.";

  let reasoning;
  if (reasonsGood.length === 0 && reasonsBad.length === 0) {
    reasoning = "On-chain data didn't come back for this address — double check it's a valid token contract.";
  } else if (tier === "clear") {
    reasoning = reasonsGood.slice(0, 3).join(", ") + ".";
  } else {
    const lead = reasonsBad.slice(0, 2).join(" and ");
    const support = reasonsGood.length ? ` ${reasonsGood[0]} though.` : "";
    reasoning = lead.charAt(0).toUpperCase() + lead.slice(1) + "." + support;
  }
  if (totalHolders !== null) {
    reasoning = `${totalHolders.toLocaleString()} total holders. ` + reasoning;
  }
  // Honest caveat instead of a silently wrong number: no /pairs endpoint on this
  // chain yet, so the LP pool address can't be excluded from the top-holders list.
  reasoning += " Note: this chain doesn't expose DEX pair data yet, so the top holders may include the liquidity pool itself.";

  return {
    address,
    chainKey,
    provider: "blockscout", // no market cap / ATH / pool age here — see marketDataUnavailableReason
    marketDataUnavailableReason:
      "Robinhood Chain doesn't have DEX pair data indexed yet, so market cap, ATH, and pool age aren't computable here the way they are on the other chains.",
    tier,
    flags,
    headline,
    reasoning,
    topHolderPct,
    totalHolders,
    transfersCount: counters.transfersCount,
    websites: [],
    socials: [],
    holders,
    sniperCount,
    bundledCount,

  };
}

async function analyze(address, chainKey = DEFAULT_CHAIN) {
  const addr = address.trim();

  if (PROVIDER_BY_CHAIN[chainKey] === "blockscout") {
    return analyzeBlockscout(addr, chainKey);
  }

  // Fetch pairs first — needed to filter the LP address out of top holders and to pick
  // the right pair for price candles.
  const pairsInfo = await getPairs(chainKey, addr).catch(() => ({ pairs: [], pairAddressSet: new Set(), bestPair: null }));

  const [metaPriceResult, dexScreenerResult] = await Promise.allSettled([
    getTokenMetaAndPrice(chainKey, addr),
    getDexScreenerMarketData(chainKey, addr),
  ]);
  const metaPrice = metaPriceResult.status === "fulfilled" ? metaPriceResult.value : { usdPrice: null, supply: null };
  const dexScreener = dexScreenerResult.status === "fulfilled" ? dexScreenerResult.value : null;

  // Candles MUST come from the same pair DexScreener used for the market cap figure
  // above — pulling from a different (Moralis-picked) pair risks an ATH computed off
  // a wild trade on a thin, unrelated pool that has nothing to do with the price
  // anyone actually sees. Only fall back to Moralis's own pick if DexScreener has
  // nothing for this token.
  const candlePairAddress = dexScreener?.pairAddress || pairsInfo.bestPair?.pair_address || null;
  const candles = await getCandles(chainKey, candlePairAddress).catch(() => []);

  // Prefer DexScreener's real, published market cap. Fall back to price × on-chain
  // total supply (technically FDV, not true market cap) only if DexScreener has
  // nothing for this chain/token — flagged honestly in the UI either way.
  const marketCap = dexScreener?.marketCap ?? (metaPrice.usdPrice && metaPrice.supply ? metaPrice.usdPrice * metaPrice.supply : null);
  const marketCapIsEstimate = dexScreener?.marketCap == null;
  const supplyForAth = dexScreener?.impliedSupply ?? metaPrice.supply;
  const ath = computeAth(candles, supplyForAth);

  const holdersResult = await analyzeHolders(chainKey, addr, pairsInfo.pairAddressSet, candles, supplyForAth).catch(() => null);
  const holderData = holdersResult;

  const topHolderPct = holderData ? holderData.totalPct : null;
  const totalHolders = holderData ? holderData.totalHolders : null;
  const holders = holderData ? holderData.holders : [];
  const sniperCount = holders.filter((h) => h.isSniper === true).length;
  const bundledCount = holders.filter((h) => h.isBundled).length;

  let flags = 0;
  if (topHolderPct !== null && topHolderPct > 40) flags++;
  if (sniperCount >= 2) flags++;
  if (bundledCount >= 2) flags++;

  let tier = "clear";
  if (flags >= 3) tier = "risk";
  else if (flags >= 1) tier = "caution";

  const reasonsGood = [];
  const reasonsBad = [];
  if (topHolderPct !== null) {
    if (topHolderPct <= 40) reasonsGood.push(`top 10 wallets hold ${topHolderPct}%`);
    else reasonsBad.push(`top 10 wallets hold ${topHolderPct}%`);
  }
  if (sniperCount > 0) reasonsBad.push(`${sniperCount} of the top 10 holders sniped the launch block`);
  if (bundledCount > 0) reasonsBad.push(`${bundledCount} top holders bought in the same bundled block`);

  const headline =
    reasonsGood.length === 0 && reasonsBad.length === 0
      ? "Not enough data yet."
      : tier === "clear"
      ? "Looks clean."
      : tier === "caution"
      ? "Worth a second look."
      : "Proceed carefully.";

  let reasoning;
  if (reasonsGood.length === 0 && reasonsBad.length === 0) {
    reasoning = "On-chain data didn't come back for this address — double check it's a valid token contract.";
  } else if (tier === "clear") {
    reasoning = reasonsGood.slice(0, 3).join(", ") + ".";
  } else {
    const lead = reasonsBad.slice(0, 2).join(" and ");
    const support = reasonsGood.length ? ` ${reasonsGood[0]} though.` : "";
    reasoning = lead.charAt(0).toUpperCase() + lead.slice(1) + "." + support;
  }
  if (totalHolders !== null) {
    reasoning = `${totalHolders.toLocaleString()} total holders. ` + reasoning;
  }

  return {
    address: addr,
    chainKey,
    provider: "moralis",
    tier,
    flags,
    headline,
    reasoning,
    topHolderPct,
    totalHolders,
    marketCap,
    marketCapIsEstimate,
    ath,
    websites: dexScreener?.websites || [],
    socials: dexScreener?.socials || [],
    poolAgeDays: dexScreener?.poolAgeDays ?? null,
    liquidityUsd: dexScreener?.liquidityUsd ?? null,
    priceUsd: dexScreener?.priceUsd ?? metaPrice.usdPrice ?? null,
    holders,
    sniperCount,
    bundledCount,
  };
}

const CHECK_STEPS = ["Checking holder distribution", "Checking market data", "Checking deployer history"];

const EXAMPLES = [
  { name: "GRID", address: "0x71a...4e2c", tier: "clear", line: "1,240 holders, top 10 hold 22%, deployer wallet 210d old." },
  { name: "MOON9", address: "0x0f3...9ab1", tier: "risk", line: "3 of the top 10 sniped the launch block. Deployer wallet is 2d old." },
  { name: "ORBIT", address: "0x8c2...117d", tier: "caution", line: "Top 10 wallets hold 47% of supply." },
];

function tierColor(tier) {
  if (tier === "clear") return "var(--ink)";
  if (tier === "caution") return "var(--amber)";
  return "var(--amber-deep)";
}

// DexScreener gives platform + handle, not always a ready-to-click URL.
function socialUrl(s) {
  const handle = s.handle || "";
  if (/^https?:\/\//i.test(handle)) return handle;
  const platform = (s.platform || "").toLowerCase();
  const clean = handle.replace(/^@/, "");
  if (platform.includes("twitter") || platform === "x") return `https://x.com/${clean}`;
  if (platform.includes("telegram")) return `https://t.me/${clean}`;
  if (platform.includes("discord")) return handle.startsWith("http") ? handle : `https://discord.gg/${clean}`;
  return handle || "#";
}

function formatUsd(value, precise = false) {
  if (value === null || value === undefined || Number.isNaN(value)) return "Unavailable";
  if (value === 0) return "$0";
  if (precise && value < 1) return `$${value.toFixed(6)}`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function SifterMark({ size = 28, active = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" style={{ display: "block" }}>
      <path d="M6 8 L34 8 L21 22 L21 30" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="21" cy={active ? undefined : 33} r="2.6" fill="var(--amber)">
        {active && (
          <animate attributeName="cy" values="14;30;30;14" keyTimes="0;0.6;0.9;1" dur="1.4s" repeatCount="indefinite" />
        )}
      </circle>
    </svg>
  );
}

export default function Sift() {
  const [input, setInput] = useState("");
  const [chain, setChain] = useState(DEFAULT_CHAIN);
  const [phase, setPhase] = useState("idle"); // idle | checking | result
  const [stepIndex, setStepIndex] = useState(0);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [holdersOpen, setHoldersOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [onchainStatus, setOnchainStatus] = useState("idle"); // idle | pending | done | error
  const [onchainTxHash, setOnchainTxHash] = useState(null);
  const [onchainError, setOnchainError] = useState(null);
  const timers = useRef([]);

  useEffect(() => {
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const handleLogOnchain = async () => {
    if (!result) return;
    setOnchainStatus("pending");
    setOnchainError(null);
    try {
      const hash = await logScanOnchain(result);
      setOnchainTxHash(hash);
      setOnchainStatus("done");
    } catch (err) {
      setOnchainStatus("error");
      setOnchainError(err?.shortMessage || err?.message || "Couldn't log the scan onchain.");
    }
  };

  const runCheck = async () => {
    if (!input.trim()) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setExpanded(false);
    setHoldersOpen(false);
    setError(null);
    setOnchainStatus("idle");
    setOnchainTxHash(null);
    setOnchainError(null);
    setPhase("checking");
    setStepIndex(0);

    CHECK_STEPS.forEach((_, i) => {
      const t = setTimeout(() => setStepIndex((prev) => Math.min(prev + 1, i + 1)), (i + 1) * 420);
      timers.current.push(t);
    });
    const minWait = new Promise((resolve) => {
      const t = setTimeout(resolve, CHECK_STEPS.length * 420);
      timers.current.push(t);
    });

    try {
      const [analysis] = await Promise.all([analyze(input, chain), minWait]);
      setStepIndex(CHECK_STEPS.length);
      setResult(analysis);
      setPhase("result");
    } catch (err) {
      timers.current.forEach(clearTimeout);
      setError(err?.message || "Couldn't reach the data provider. Check the address and your API keys.");
      setPhase("idle");
    }
  };

  const reset = () => {
    setPhase("idle");
    setResult(null);
    setInput("");
    setExpanded(false);
    setHoldersOpen(false);
    setOnchainStatus("idle");
    setOnchainTxHash(null);
    setOnchainError(null);
  };

  const loadExample = (addr) => setInput(addr);

  return (
    <div className="sift-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');

        .sift-root {
          --bg: #FAF8F3;
          --ink: #1A1A18;
          --ink-soft: #6B6862;
          --amber: #C9832F;
          --amber-deep: #A8631E;
          --amber-tint: #F3E4CE;
          --line: #E7E1D3;
          --card: #FFFFFF;
          background: var(--bg);
          color: var(--ink);
          font-family: 'Inter', sans-serif;
          min-height: 100%;
          width: 100%;
          padding: 0;
        }
        .sift-serif { font-family: 'Fraunces', serif; }
        .sift-mono { font-family: 'JetBrains Mono', monospace; }

        .sift-nav {
          display: flex; align-items: center; justify-content: space-between;
          padding: 28px 48px; max-width: 1080px; margin: 0 auto;
        }
        .sift-nav-tag { color: var(--ink-soft); font-size: 13px; letter-spacing: 0.02em; }

        .sift-hero {
          max-width: 720px; margin: 0 auto; padding: 56px 48px 24px;
          text-align: center;
        }
        .sift-h1 {
          color: var(--ink);
          font-size: 46px; line-height: 1.08; font-weight: 600; letter-spacing: -0.01em;
          margin: 0 0 16px;
        }
        .sift-sub {
          color: var(--ink-soft); font-size: 17px; line-height: 1.5; margin: 0 auto 36px;
          max-width: 460px;
        }

        .sift-chain-select {
          display: flex; justify-content: center; gap: 6px; margin-bottom: 14px;
        }
        .sift-chain-pill {
          font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--ink-soft);
          background: transparent; border: 1px solid var(--line); border-radius: 100px;
          padding: 6px 14px; cursor: pointer; transition: all 0.15s;
        }
        .sift-chain-pill:hover { border-color: var(--ink-soft); color: var(--ink); }
        .sift-chain-pill.active { background: var(--ink); border-color: var(--ink); color: var(--bg); }
        .sift-chain-pill:disabled { opacity: 0.5; cursor: default; }

        .sift-input-wrap {
          max-width: 620px; margin: 0 auto 8px;
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 8px 8px 8px 20px;
          display: flex; align-items: center; gap: 12px;
          box-shadow: 0 1px 2px rgba(26,26,24,0.03);
        }
        .sift-input {
          flex: 1; border: none; outline: none; background: transparent;
          font-family: 'JetBrains Mono', monospace; font-size: 14.5px; color: var(--ink);
          padding: 10px 0;
        }
        .sift-input::placeholder { color: #ABA694; }
        .sift-btn {
          background: var(--ink); color: var(--bg); border: none; border-radius: 9px;
          padding: 12px 20px; font-family: 'Inter', sans-serif; font-weight: 500; font-size: 14px;
          cursor: pointer; white-space: nowrap;
        }
        .sift-btn:hover { background: #33322e; }
        .sift-btn:disabled { opacity: 0.4; cursor: default; }
        .sift-btn:focus-visible, .sift-input:focus-visible, .sift-chip:focus-visible, .sift-more:focus-visible {
          outline: 2px solid var(--amber); outline-offset: 2px;
        }

        .sift-examples-row {
          display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 14px;
        }
        .sift-chip {
          font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ink-soft);
          background: transparent; border: 1px solid var(--line); border-radius: 100px;
          padding: 6px 12px; cursor: pointer;
        }
        .sift-chip:hover { border-color: var(--ink-soft); color: var(--ink); }

        .sift-stage {
          max-width: 620px; margin: 32px auto 0; min-height: 40px;
        }

        .sift-checking {
          display: flex; flex-direction: column; align-items: center; gap: 18px;
          padding: 40px 0;
        }
        .sift-steps { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
        .sift-step {
          font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #C6C1B2;
          display: flex; align-items: center; gap: 8px; transition: color 0.2s ease;
        }
        .sift-step.active { color: var(--ink-soft); }
        .sift-step.done { color: var(--ink); }
        .sift-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }

        .sift-card {
          background: var(--card); border: 1px solid var(--line); border-radius: 16px;
          padding: 36px 36px 24px; margin-top: 8px;
        }
        .sift-verdict-eyebrow {
          font-family: 'JetBrains Mono', monospace; font-size: 11.5px; letter-spacing: 0.06em;
          color: var(--ink-soft); text-transform: uppercase; margin-bottom: 10px;
        }
        .sift-verdict-h {
          font-family: 'Fraunces', serif; font-size: 32px; margin: 0 0 12px; line-height: 1.15;
        }
        .sift-verdict-reason {
          color: var(--ink-soft); font-size: 15px; line-height: 1.55; margin: 0 0 22px; max-width: 480px;
        }
        .sift-links-row {
          display: flex; gap: 8px; flex-wrap: wrap; margin: -10px 0 20px;
        }
        .sift-link-pill {
          font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ink-soft);
          background: transparent; border: 1px solid var(--line); border-radius: 100px;
          padding: 5px 12px; text-decoration: none; text-transform: capitalize;
          transition: all 0.15s;
        }
        .sift-link-pill:hover { border-color: var(--ink-soft); color: var(--ink); }
        .sift-more {
          background: none; border: none; padding: 0; cursor: pointer;
          font-family: 'Inter', sans-serif; font-size: 13.5px; color: var(--ink-soft);
          display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
        }
        .sift-more:hover { color: var(--ink); }
        .sift-data { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 18px; }
        .sift-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px;
        }
        .sift-row:last-child { border-bottom: none; }
        .sift-row-label { color: var(--ink-soft); }
        .sift-row-val { font-family: 'JetBrains Mono', monospace; font-size: 13px; }

        .sift-row-toggle {
          width: 100%; background: none; border: none; padding: 10px 0; cursor: pointer;
          font-family: inherit; text-align: left;
        }
        .sift-row-toggle:hover .sift-row-label { color: var(--ink); }

        .sift-holders { margin: 0 0 4px; padding: 2px 0 10px 19px; }
        .sift-holder-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 7px 0; font-size: 13px;
        }
        .sift-holder-addr { font-family: 'JetBrains Mono', monospace; color: var(--ink-soft); }
        .sift-holder-sent { font-size: 11px; color: #ABA694; }
        .sift-holder-tags { display: flex; align-items: center; gap: 8px; }
        .sift-holder-pct { font-family: 'JetBrains Mono', monospace; color: var(--ink); min-width: 36px; text-align: right; }
        .sift-tag {
          font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.02em;
          padding: 2px 7px; border-radius: 100px; text-transform: uppercase;
        }
        .sift-tag-amber { background: var(--amber-tint); color: var(--amber-deep); }

        .sift-onchain-row {
          margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line);
          display: flex; align-items: center;
        }
        .sift-onchain-btn {
          background: none; border: 1px solid var(--line); border-radius: 100px;
          padding: 7px 14px; font-family: 'Inter', sans-serif; font-size: 12.5px; font-weight: 500;
          color: var(--ink-soft); cursor: pointer; transition: all 0.15s;
        }
        .sift-onchain-btn:hover { border-color: var(--amber); color: var(--amber-deep); }
        .sift-onchain-pending {
          display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-soft);
          font-family: 'JetBrains Mono', monospace;
        }
        .sift-spin { animation: sift-spin 0.9s linear infinite; }
        @keyframes sift-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .sift-onchain-done {
          display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--amber-deep);
          font-family: 'JetBrains Mono', monospace; text-decoration: none;
        }
        .sift-onchain-done:hover { text-decoration: underline; }
        .sift-onchain-error {
          display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--amber-deep);
          font-family: 'Inter', sans-serif;
        }
        .sift-onchain-retry {
          background: none; border: 1px solid var(--line); border-radius: 100px; padding: 4px 10px;
          font-size: 12px; cursor: pointer; color: var(--ink-soft);
        }
        .sift-onchain-retry:hover { border-color: var(--ink-soft); color: var(--ink); }

        .sift-card-foot {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line);
        }
        .sift-addr {
          font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ink-soft);
          display: flex; align-items: center; gap: 6px;
        }
        .sift-copy { background: none; border: none; cursor: pointer; color: var(--ink-soft); display: flex; }
        .sift-copy:hover { color: var(--ink); }
        .sift-reset {
          background: none; border: none; cursor: pointer; font-size: 13px; color: var(--ink-soft);
          font-family: 'Inter', sans-serif;
        }
        .sift-reset:hover { color: var(--ink); }

        .sift-examples-section {
          max-width: 900px; margin: 80px auto 0; padding: 0 48px 100px;
        }
        .sift-examples-title {
          text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
          letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 24px;
        }
        .sift-examples-grid {
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
        }
        @media (max-width: 720px) {
          .sift-examples-grid { grid-template-columns: 1fr; }
          .sift-h1 { font-size: 34px; }
          .sift-hero { padding: 40px 24px 16px; }
          .sift-nav { padding: 24px; }
        }
        .sift-ex-card {
          background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px;
        }
        .sift-ex-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .sift-ex-name { font-family: 'Fraunces', serif; font-size: 17px; font-weight: 600; }
        .sift-ex-addr { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #ABA694; }
        .sift-ex-verdict { font-family: 'Fraunces', serif; font-size: 15px; margin: 8px 0 6px; }
        .sift-ex-line { font-size: 12.5px; color: var(--ink-soft); line-height: 1.5; }

        .sift-footer {
          text-align: center; padding: 0 24px 60px; color: #ABA694; font-size: 12.5px;
          font-family: 'JetBrains Mono', monospace;
        }
      `}</style>

      <nav className="sift-nav">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SifterMark size={22} />
          <span className="sift-serif" style={{ fontSize: 19, fontWeight: 600 }}>Sift</span>
        </div>
        <div className="sift-nav-tag sift-mono">one check. not twelve tabs.</div>
      </nav>

      <header className="sift-hero">
        <h1 className="sift-h1 sift-serif">One token.<br />One straight answer.</h1>
        <p className="sift-sub">
          Stop juggling five tools to figure out if it's safe. Paste an address —
          Sift pulls the data together in seconds.
        </p>

        <div className="sift-chain-select">
          {Object.entries(CHAINS).map(([key, c]) => (
            <button
              key={key}
              className={`sift-chain-pill ${chain === key ? "active" : ""}`}
              onClick={() => setChain(key)}
              disabled={phase === "checking"}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="sift-input-wrap">
          <input
            className="sift-input"
            placeholder="Paste a contract address (0x...)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && phase !== "checking" && runCheck()}
            disabled={phase === "checking"}
          />
          <button className="sift-btn" onClick={runCheck} disabled={phase === "checking" || !input.trim()}>
            {phase === "checking" ? "Sifting…" : "Sift it"}
          </button>
        </div>

        {error && (
          <div style={{ maxWidth: 620, margin: "10px auto 0", fontSize: 13, color: "var(--amber-deep)", fontFamily: "JetBrains Mono, monospace" }}>
            {error}
          </div>
        )}

        {phase === "idle" && (
          <div className="sift-examples-row">
            {EXAMPLES.map((ex) => (
              <button key={ex.name} className="sift-chip" onClick={() => loadExample(ex.address)}>
                try {ex.address}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="sift-stage">
        {phase === "checking" && (
          <div className="sift-checking">
            <SifterMark size={36} active />
            <div className="sift-steps">
              {CHECK_STEPS.map((s, i) => (
                <div key={s} className={`sift-step ${i < stepIndex ? "done" : i === stepIndex ? "active" : ""}`}>
                  <span className="sift-dot" />
                  {s}{i < stepIndex ? " — done" : "…"}
                </div>
              ))}
            </div>
          </div>
        )}

        {phase === "result" && result && (
          <div className="sift-card">
            <div className="sift-verdict-eyebrow">Verdict · {CHAINS[result.chainKey]?.label || "Monad"}</div>
            <h2 className="sift-verdict-h" style={{ color: tierColor(result.tier) }}>
              {result.headline}
            </h2>
            <p className="sift-verdict-reason">{result.reasoning}</p>

            {(result.websites.length > 0 || result.socials.length > 0) && (
              <div className="sift-links-row">
                {result.websites.slice(0, 1).map((url) => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="sift-link-pill">
                    Website
                  </a>
                ))}
                {result.socials.map((s) => (
                  <a
                    key={s.platform + s.handle}
                    href={socialUrl(s)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sift-link-pill"
                  >
                    {s.platform}
                  </a>
                ))}
              </div>
            )}

            <button className="sift-more" onClick={() => setExpanded((v) => !v)}>
              <ChevronDown size={15} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
              {expanded ? "Hide the data" : "Show the data"}
            </button>

            {expanded && (
              <div className="sift-data">
                {result.provider === "blockscout" ? (
                  <>
                    <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, margin: "0 0 14px" }}>
                      {result.marketDataUnavailableReason}
                    </p>
                    {result.totalHolders !== null && (
                      <div className="sift-row">
                        <span className="sift-row-label">Total holders</span>
                        <span className="sift-row-val">{result.totalHolders.toLocaleString()}</span>
                      </div>
                    )}
                    {result.transfersCount !== null && (
                      <div className="sift-row">
                        <span className="sift-row-label">Transfers</span>
                        <span className="sift-row-val">{result.transfersCount.toLocaleString()}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {result.marketCap !== null && (
                      <div className="sift-row">
                        <span className="sift-row-label">Market cap{result.marketCapIsEstimate ? " (est.)" : ""}</span>
                        <span className="sift-row-val">{formatUsd(result.marketCap)}</span>
                      </div>
                    )}
                    {result.ath ? (
                      <div className="sift-row">
                        <span className="sift-row-label">ATH market cap {result.ath.date ? `(${result.ath.date})` : ""}</span>
                        <span className="sift-row-val">{formatUsd(result.ath.marketCap)}</span>
                      </div>
                    ) : result.liquidityUsd !== null ? (
                      <div className="sift-row">
                        <span className="sift-row-label">Liquidity</span>
                        <span className="sift-row-val">{formatUsd(result.liquidityUsd)}</span>
                      </div>
                    ) : null}
                    {result.poolAgeDays !== null ? (
                      <div className="sift-row">
                        <span className="sift-row-label">Pool age</span>
                        <span className="sift-row-val">{result.poolAgeDays}d</span>
                      </div>
                    ) : result.priceUsd !== null ? (
                      <div className="sift-row">
                        <span className="sift-row-label">Price</span>
                        <span className="sift-row-val">{formatUsd(result.priceUsd, true)}</span>
                      </div>
                    ) : null}
                    {result.totalHolders !== null && (
                      <div className="sift-row">
                        <span className="sift-row-label">Total holders</span>
                        <span className="sift-row-val">{result.totalHolders.toLocaleString()}</span>
                      </div>
                    )}
                  </>
                )}

                <button className="sift-row sift-row-toggle" onClick={() => setHoldersOpen((v) => !v)}>
                  <span className="sift-row-label">
                    <ChevronDown
                      size={13}
                      style={{ transform: holdersOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s", marginRight: 6, verticalAlign: -2 }}
                    />
                    Top 10 holder concentration
                  </span>
                  <span className="sift-row-val">{result.topHolderPct !== null ? `${result.topHolderPct}%` : "Unavailable"}</span>
                </button>

                {holdersOpen && result.holders && result.holders.length > 0 && (
                  <div className="sift-holders">
                    {result.holders.map((h) => (
                      <div className="sift-holder-row" key={h.address}>
                        <span>
                          <span className="sift-holder-addr" style={{ display: "block" }}>
                            {h.address ? `${h.address.slice(0, 8)}…${h.address.slice(-6)}` : "unknown"}
                          </span>
                          <span className="sift-holder-sent">
                            sent to {h.sentToCount} wallet{h.sentToCount === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="sift-holder-tags">
                          {h.isSniper === true && <span className="sift-tag sift-tag-amber">sniper</span>}
                          {h.isBundled && <span className="sift-tag sift-tag-amber">bundled</span>}
                          <span className="sift-holder-pct">{h.pct}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="sift-onchain-row">
              {onchainStatus === "idle" && (
                <button className="sift-onchain-btn" onClick={handleLogOnchain}>
                  Log this verdict onchain
                </button>
              )}
              {onchainStatus === "pending" && (
                <span className="sift-onchain-pending">
                  <Loader2 size={13} className="sift-spin" /> Waiting for wallet confirmation…
                </span>
              )}
              {onchainStatus === "done" && (
                <a
                  className="sift-onchain-done"
                  href={`https://testnet.monadvision.com/tx/${onchainTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Check size={13} /> Logged onchain <ExternalLink size={12} />
                </a>
              )}
              {onchainStatus === "error" && (
                <span className="sift-onchain-error">
                  {onchainError}
                  <button className="sift-onchain-retry" onClick={handleLogOnchain}>Retry</button>
                </span>
              )}
            </div>

            <div className="sift-card-foot">
              <div className="sift-addr">
                {result.address.length > 20 ? `${result.address.slice(0, 10)}…${result.address.slice(-6)}` : result.address}
                <button
                  className="sift-copy"
                  onClick={() => {
                    navigator.clipboard?.writeText(result.address).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  aria-label="Copy address"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
              <button className="sift-reset" onClick={reset}>Sift another</button>
            </div>
          </div>
        )}
      </div>

      <section className="sift-examples-section">
        <div className="sift-examples-title">what a sift looks like</div>
        <div className="sift-examples-grid">
          {EXAMPLES.map((ex) => (
            <div className="sift-ex-card" key={ex.name}>
              <div className="sift-ex-top">
                <span className="sift-ex-name">{ex.name}</span>
                <span className="sift-ex-addr">{ex.address}</span>
              </div>
              <div className="sift-ex-verdict" style={{ color: tierColor(ex.tier) }}>
                {ex.tier === "clear" ? "Looks clean." : ex.tier === "caution" ? "Worth a second look." : "Proceed carefully."}
              </div>
              <div className="sift-ex-line">{ex.line}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="sift-footer">sift · built for spark</div>
    </div>
  );
}