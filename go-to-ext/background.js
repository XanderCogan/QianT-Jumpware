// --- tiny fuzzy subsequence matcher ---
const fuzzyScore = (q, t) => {
  q = q.toLowerCase().trim(); t = t.toLowerCase();
  if (!q) return -9999;
  let qi = 0, jumps = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++; else jumps++;
  }
  if (qi < q.length) return -Infinity;         // query not found as subsequence
  return -jumps - t.length * 0.001;            // fewer jumps + shorter targets rank higher
};

// --- restrict to Docs + GitHub + Chrome URLs ---
const HOST_ALLOW = /(^|\.)docs\.google\.com$|(^|\.)github\.com$/i;
const isChromeUrl = (url) => url.startsWith('chrome://') || url.startsWith('chrome-extension://');

// --- Normalize URLs for deduplication ---
function normalizeUrlForDedup(url) {
  try {
    const u = new URL(url);
    if (/docs\.google\.com/i.test(u.hostname)) {
      // Extract document ID from path: /document/d/DOC_ID/...
      const match = u.pathname.match(/\/document\/d\/([^\/]+)/);
      if (match) {
        return `https://docs.google.com/document/d/${match[1]}`;
      }
      // Similar for sheets and slides
      const sheetMatch = u.pathname.match(/\/spreadsheets\/d\/([^\/]+)/);
      if (sheetMatch) {
        return `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}`;
      }
      const slideMatch = u.pathname.match(/\/presentation\/d\/([^\/]+)/);
      if (slideMatch) {
        return `https://docs.google.com/presentation/d/${slideMatch[1]}`;
      }
    } else if (/github\.com/i.test(u.hostname)) {
      // Normalize GitHub URLs: github.com/owner/repo
      const parts = u.pathname.split('/').filter(p => p);
      if (parts.length >= 2) {
        return `https://github.com/${parts[0]}/${parts[1]}`;
      }
    }
    // For other URLs, remove query and fragment
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return url; // Fallback to original
  }
}

const normalizeItem = (url, title = "", extractedContent = null) => {
  try {
    // Allow chrome:// URLs (no hostname check needed)
    if (isChromeUrl(url)) {
      const finalTitle = extractedContent?.title || title || url;
      return {
        url: url,
        title: finalTitle && finalTitle.trim() ? finalTitle : url,
        host: 'chrome://',
        kind: 'Chrome',
        content: extractedContent?.content || '',
        headings: extractedContent?.headings || '',
        extractedAt: extractedContent?.extractedAt || null
      };
    }
    
    const u = new URL(url);
    if (!HOST_ALLOW.test(u.hostname)) return null;

    // Use extracted title if available, otherwise use provided title
    const finalTitle = extractedContent?.title || title || url;
    let label = finalTitle;
    let kind = "Other";

    if (/docs\.google\.com/i.test(u.hostname)) {
      if (u.pathname.startsWith("/document/")) kind = "Google Doc";
      else if (u.pathname.startsWith("/spreadsheets/")) kind = "Google Sheet";
      else if (u.pathname.startsWith("/presentation/")) kind = "Google Slides";
      else kind = "Google Docs";

      // Fall back to a human-ish ID if no title
      label = finalTitle && finalTitle.trim() ? finalTitle : `[${kind}] ${u.pathname.split("/")[3] || ""}`;
    } else if (/github\.com/i.test(u.hostname)) {
      const [, owner, repo] = u.pathname.split("/");
      if (owner && repo) { kind = "GitHub"; label = finalTitle && finalTitle.trim() ? finalTitle : `${owner}/${repo}`; }
      else kind = "GitHub";
    }

    return { 
      url: u.toString(), 
      title: label, 
      host: u.hostname, 
      kind,
      content: extractedContent?.content || '',
      headings: extractedContent?.headings || '',
      extractedAt: extractedContent?.extractedAt || null
    };
  } catch { return null; }
};

const dedupeByUrl = (arr) => {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (x && x.url) {
      const normalized = normalizeUrlForDedup(x.url);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(x);
      }
    }
  }
  return out;
};

// --- In-memory index cache for fast access ---
let indexCache = null;
let indexCacheTimestamp = 0;
const INDEX_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- build + cache index in chrome.storage.local ---
async function buildIndex() {
  const [hist, tree] = await Promise.all([
    chrome.history.search({ text: "", maxResults: 1000 }),
    new Promise((res) => chrome.bookmarks.getTree(res))
  ]);

  const fromHistory = hist.map(h => normalizeItem(h.url, h.title)).filter(Boolean);

  const fromBookmarks = [];
  const walk = (n) => {
    if (n.url) {
      const it = normalizeItem(n.url, n.title);
      if (it) fromBookmarks.push(it);
    }
    (n.children || []).forEach(walk);
  };
  tree.forEach(walk);

  const index = dedupeByUrl([...fromBookmarks, ...fromHistory]);
  const timestamp = Date.now();
  await chrome.storage.local.set({ index, index_timestamp: timestamp });
  // Update in-memory cache
  indexCache = index;
  indexCacheTimestamp = timestamp;
  return index;
}

// Load index into memory on startup
async function loadIndexToMemory() {
  const { index, index_timestamp } = await chrome.storage.local.get(["index", "index_timestamp"]);
  if (index) {
    indexCache = index;
    indexCacheTimestamp = index_timestamp || Date.now();
  } else {
    indexCache = await buildIndex();
    indexCacheTimestamp = Date.now();
  }
}

// Fast in-memory index getter (no async I/O if cache is fresh)
async function getIndexFast() {
  // If cache is fresh, return immediately (no async I/O!)
  if (indexCache && (Date.now() - indexCacheTimestamp) < INDEX_CACHE_TTL) {
    return indexCache;
  }
  // Otherwise refresh
  indexCache = await buildIndex();
  indexCacheTimestamp = Date.now();
  return indexCache;
}

// Legacy function for compatibility
async function getIndexFresh() {
  return await getIndexFast();
}

// refresh periodically as you browse (rate-limited)
chrome.history.onVisited.addListener(async () => {
  const { index_timestamp } = await chrome.storage.local.get("index_timestamp");
  if (!index_timestamp || (Date.now() - index_timestamp) > 60 * 1000) {
    // buildIndex() already updates indexCache, so this is fine
    await buildIndex();
  }
});

// --- Extract content from a tab ---
async function extractContentFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'extractPageContent' });
    if (response && response.success) {
      return response.data;
    }
  } catch (e) {
    // Content script might not be available
    console.log('[Jumpware] Could not extract page content:', e.message);
  }
  return null;
}

// --- Cache for on-screen links and OTP detection ---
let screenSnapshot = {
  links: [],
  otpGmailUrl: null,
  tabId: null,
  timestamp: 0
};

const SNAPSHOT_TTL = 15000; // 15 seconds

// --- Check and request host permissions if needed ---
async function ensureHostPermissions() {
  try {
    const hasPermissions = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (!hasPermissions) {
      // Request permissions on first use
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      return granted;
    }
    return true;
  } catch (error) {
    console.log('[Jumpware] Error checking permissions:', error);
    return false;
  }
}

// --- Request screen snapshot from active tab ---
async function requestScreenSnapshot() {
  try {
    // Check permissions first (graceful degradation if denied)
    const hasPermissions = await ensureHostPermissions();
    if (!hasPermissions) {
      return null; // Silently degrade - Docs/GitHub suggestions still work
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return null;

    // Check if we have a fresh snapshot for this tab
    if (screenSnapshot.tabId === tab.id && 
        (Date.now() - screenSnapshot.timestamp) < SNAPSHOT_TTL) {
      return screenSnapshot;
    }

    // Request visible links
    let links = [];
    try {
      const linksResponse = await chrome.tabs.sendMessage(tab.id, { action: 'collectVisibleLinks' });
      if (linksResponse && linksResponse.success) {
        links = linksResponse.links || [];
      }
    } catch (e) {
      // Content script might not be available (e.g., chrome:// pages)
      console.log('[Jumpware] Could not collect visible links:', e.message);
    }

    // Request OTP detection
    let otpGmailUrl = null;
    try {
      const otpResponse = await chrome.tabs.sendMessage(tab.id, { action: 'detectOTPScreen' });
      if (otpResponse && otpResponse.success && otpResponse.detected) {
        otpGmailUrl = otpResponse.gmailUrl;
      }
    } catch (e) {
      console.log('[Jumpware] Could not detect OTP screen:', e.message);
    }

    // Update snapshot
    screenSnapshot = {
      links,
      otpGmailUrl,
      tabId: tab.id,
      timestamp: Date.now()
    };

    return screenSnapshot;
  } catch (error) {
    console.log('[Jumpware] Error requesting screen snapshot:', error);
    return null;
  }
}

// --- Clear snapshot on tab change ---
chrome.tabs.onActivated.addListener(() => {
  screenSnapshot = { links: [], otpGmailUrl: null, tabId: null, timestamp: 0 };
});

// Extract content asynchronously without blocking
async function extractContentAsync(tabId, url) {
  const content = await extractContentFromTab(tabId);
  if (content) {
    // Ensure index is loaded
    if (!indexCache) {
      await loadIndexToMemory();
    }
    
    if (indexCache) {
      // Check by normalized URL, not exact URL
      const normalizedUrl = normalizeUrlForDedup(url);
      const itemIndex = indexCache.findIndex(item => 
        normalizeUrlForDedup(item.url) === normalizedUrl
      );
      
      if (itemIndex >= 0) {
        // Update existing item
        indexCache[itemIndex].content = content.content || '';
        indexCache[itemIndex].headings = content.headings || '';
        if (content.title && content.title.trim() && content.title !== 'Untitled document') {
          indexCache[itemIndex].title = content.title.trim();
        }
        indexCache[itemIndex].extractedAt = content.extractedAt;
      } else {
        // Add new item
        const newItem = normalizeItem(url, '', content);
        if (newItem) {
          indexCache.push(newItem);
        }
      }
      
      // Persist to storage in background (don't await - non-blocking)
      chrome.storage.local.set({ 
        index: indexCache, 
        index_timestamp: Date.now() 
      }).catch(e => console.log('[Jumpware] Error saving index:', e));
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    if (screenSnapshot.tabId === tabId) {
      screenSnapshot = { links: [], otpGmailUrl: null, tabId: null, timestamp: 0 };
    }
  }
  
  // Extract content when page is fully loaded
  if (changeInfo.status === 'complete' && tab.url) {
    try {
      // Allow chrome:// URLs and regular allowed hosts
      if (isChromeUrl(tab.url) || (() => {
        try {
          const u = new URL(tab.url);
          return HOST_ALLOW.test(u.hostname);
        } catch {
          return false;
        }
      })()) {
        // Reduced delay - extract after minimal wait for page render
        // Note: chrome:// URLs won't have content scripts, so extractContentAsync will gracefully fail
        setTimeout(() => extractContentAsync(tabId, tab.url), 200);
      }
    } catch (e) {
      // Ignore errors (e.g., invalid URLs)
      console.log('[Jumpware] Error processing tab update:', e.message);
    }
  }
});

// --- omnibox wiring ---
chrome.omnibox.onInputStarted.addListener(async () => {
  // Request fresh snapshot when omnibox opens
  await requestScreenSnapshot();
  
  chrome.omnibox.setDefaultSuggestion({
    description: "Type a doc/repo name (e.g., ; proposal draft  ·  ; owner/repo)"
  });
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  // Use cached snapshot - don't request new one on every keystroke!
  // This avoids slow IPC calls to content scripts on every keystroke
  const snapshot = screenSnapshot.tabId ? screenSnapshot : null;
  
  const suggestions = [];
  const q = text.trim().toLowerCase();
  
  // If query is a full URL, prioritize showing it as first suggestion
  if (isFullUrlQuery(text)) {
    const normalizedUrl = normalizeUrlQuery(text);
    suggestions.push({
      content: normalizedUrl,
      description: `Open URL: <url>${escapeForOmnibox(normalizedUrl)}</url>`
    });
  }

  // 1. OTP Gmail suggestion (highest priority if detected)
  // Always show as first suggestion when OTP screen is detected
  if (snapshot && snapshot.otpGmailUrl) {
    suggestions.push({
      content: snapshot.otpGmailUrl,
      description: `Open Gmail: verification code — <url>${escapeForOmnibox(snapshot.otpGmailUrl)}</url>`
    });
  }

  // 2. On-screen links
  if (snapshot && snapshot.links && snapshot.links.length > 0) {
    for (const link of snapshot.links) {
      // Filter by query if provided
      if (!q || link.text.toLowerCase().includes(q) || link.url.toLowerCase().includes(q)) {
        suggestions.push({
          content: link.url,
          description: `Open link on screen: ${escapeForOmnibox(link.text)} — <url>${escapeForOmnibox(link.url)}</url>`
        });
      }
    }
  }

  // 3. Docs/GitHub suggestions
  const idx = await getIndexFast(); // Use fast in-memory cache
  
  // Quick pre-filter: only fuzzy score items that might match
  // This eliminates most items before expensive fuzzy matching
  const quickFilter = q.length > 0 
    ? idx.filter(item => {
        const searchable = `${item.title} ${item.url}`.toLowerCase();
        return searchable.includes(q[0]); // At least first char must match
      })
    : idx;
  
  // Get currently open URLs for cluster boost calculation
  const openUrls = await getOpenNormalizedUrls();
  
  // Only include full content in search for longer queries (3+ chars)
  // For short queries, just search title/url/kind for speed
  const scored = quickFilter.map(item => {
    const hay = q.length >= 3 
      ? `${item.title} ${item.url} ${item.kind} ${item.content || ''} ${item.headings || ''}`
      : `${item.title} ${item.url} ${item.kind}`;
    const baseScore = fuzzyScore(q, hay);
    
    // Apply cluster boost
    const clusterBoost = calculateClusterBoost(item.url, openUrls);
    
    return { item, score: baseScore + clusterBoost };
  }).filter(x => x.score !== -Infinity);

  scored.sort((a, b) => b.score - a.score);

  // Deduplicate suggestions by normalized URL
  const seenUrls = new Set();
  const uniqueScored = [];
  for (const { item, score } of scored) {
    const normalized = normalizeUrlForDedup(item.url);
    if (!seenUrls.has(normalized)) {
      seenUrls.add(normalized);
      uniqueScored.push({ item, score });
    }
  }

  // Add Docs/GitHub suggestions, maintaining max 6 total
  const maxSuggestions = 6;
  const remainingSlots = maxSuggestions - suggestions.length;
  
  if (remainingSlots > 0) {
    const docsGithubSuggestions = uniqueScored.slice(0, remainingSlots).map(({ item }) => ({
      content: item.url,
      description: `${item.kind}: ${escapeForOmnibox(item.title)} — <url>${escapeForOmnibox(item.url)}</url>`
    }));
    suggestions.push(...docsGithubSuggestions);
  }

  // Limit to max 6 suggestions
  suggest(suggestions.slice(0, maxSuggestions));
});

// open picked suggestion (or fall back to web search if user typed a raw string)
chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let url;
  
  // If text is already a URL (user selected a suggestion), use it
  if (/^https?:\/\//i.test(text) || /^chrome:\/\//i.test(text) || /^chrome-extension:\/\//i.test(text)) {
    url = text;
  } 
  // If query is a full URL, open it directly (override suggestions)
  else if (isFullUrlQuery(text)) {
    url = normalizeUrlQuery(text);
  } else {
    // Get fresh snapshot to check for OTP Gmail or on-screen links
    const snapshot = await requestScreenSnapshot();
    const q = text.trim().toLowerCase();
    
    // Priority 1: OTP Gmail (if detected, always prioritize when Enter is pressed)
    if (snapshot && snapshot.otpGmailUrl) {
      url = snapshot.otpGmailUrl;
    }
    // Priority 2: On-screen links (if query matches)
    else if (snapshot && snapshot.links && snapshot.links.length > 0) {
      const matchingLink = snapshot.links.find(link => 
        !q || link.text.toLowerCase().includes(q) || link.url.toLowerCase().includes(q)
      );
      if (matchingLink) {
        url = matchingLink.url;
      }
    }
    
    // Priority 3: Docs/GitHub suggestions
    if (!url) {
      const idx = await getIndexFast(); // Use fast in-memory cache
      
      // Pre-filter for performance
      const quickFilter = q.length > 0 
        ? idx.filter(item => {
            const searchable = `${item.title} ${item.url}`.toLowerCase();
            return searchable.includes(q[0]);
          })
        : idx;
      
      // Get currently open URLs for cluster boost calculation
      const openUrls = await getOpenNormalizedUrls();
      
      const scored = quickFilter.map(item => {
        // Include content for longer queries
        const hay = q.length >= 3 
          ? `${item.title} ${item.url} ${item.kind} ${item.content || ''} ${item.headings || ''}`
          : `${item.title} ${item.url} ${item.kind}`;
        const baseScore = fuzzyScore(q, hay);
        
        // Apply cluster boost
        const clusterBoost = calculateClusterBoost(item.url, openUrls);
        
        return { item, score: baseScore + clusterBoost };
      }).filter(x => x.score !== -Infinity);

      scored.sort((a, b) => b.score - a.score);
      
      // Deduplicate by normalized URL
      const seenUrls = new Set();
      const uniqueScored = [];
      for (const { item, score } of scored) {
        const normalized = normalizeUrlForDedup(item.url);
        if (!seenUrls.has(normalized)) {
          seenUrls.add(normalized);
          uniqueScored.push({ item, score });
        }
      }
      
      // Use first suggestion if available, otherwise fall back to Google search
      url = uniqueScored.length > 0 
        ? uniqueScored[0].item.url 
        : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    }
  }

  if (disposition === "currentTab") chrome.tabs.update({ url });
  else if (disposition === "newForegroundTab") chrome.tabs.create({ url });
  else chrome.tabs.create({ url, active: false });
});

// --- Detect if query is a full URL ---
function isFullUrlQuery(query) {
  const trimmed = query.trim();
  // Contains protocol (://)
  if (trimmed.includes('://')) return true;
  // Matches pattern like domain.com, domain.org, etc. (has TLD)
  // Pattern: starts with alphanumeric, has dots, ends with TLD (2+ chars) optionally followed by / or end
  const urlPattern = /^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\s)/i;
  if (urlPattern.test(trimmed)) return true;
  return false;
}

// --- Normalize URL query to proper URL format ---
function normalizeUrlQuery(query) {
  const trimmed = query.trim();
  // If already has protocol, return as-is
  if (trimmed.includes('://')) return trimmed;
  // If looks like a domain, add https://
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

// utility: minimal escaping so titles/urls render safely in suggestions
function escapeForOmnibox(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// --- Link Clustering: Co-occurrence Tracking ---
let coOccurrenceData = null;
const CO_OCCURRENCE_SNAPSHOT_INTERVAL = 45000; // 45 seconds
let lastSnapshotTime = 0;
let snapshotTimeout = null;
const CLUSTER_BOOST_BASE = 50; // Base boost multiplier

// Load co-occurrence data from storage
async function loadCoOccurrenceData() {
  const { urlCoOccurrence } = await chrome.storage.local.get(['urlCoOccurrence']);
  if (urlCoOccurrence) {
    coOccurrenceData = urlCoOccurrence;
  } else {
    coOccurrenceData = {};
  }
}

// Save co-occurrence data to storage
async function saveCoOccurrenceData() {
  await chrome.storage.local.set({ urlCoOccurrence: coOccurrenceData });
}

// Record co-occurrence of URLs
function recordCoOccurrence(urls) {
  if (!coOccurrenceData) return;
  
  // Normalize all URLs
  const normalizedUrls = urls
    .map(url => normalizeUrlForDedup(url))
    .filter(url => url && url.length > 0);
  
  // Record pairwise co-occurrences
  for (let i = 0; i < normalizedUrls.length; i++) {
    const url1 = normalizedUrls[i];
    if (!coOccurrenceData[url1]) {
      coOccurrenceData[url1] = {};
    }
    
    for (let j = i + 1; j < normalizedUrls.length; j++) {
      const url2 = normalizedUrls[j];
      if (!coOccurrenceData[url2]) {
        coOccurrenceData[url2] = {};
      }
      
      // Increment co-occurrence count for both directions
      coOccurrenceData[url1][url2] = (coOccurrenceData[url1][url2] || 0) + 1;
      coOccurrenceData[url2][url1] = (coOccurrenceData[url2][url1] || 0) + 1;
    }
  }
  
  // Save periodically (debounced)
  if (snapshotTimeout) clearTimeout(snapshotTimeout);
  snapshotTimeout = setTimeout(() => {
    saveCoOccurrenceData().catch(e => console.log('[Jumpware] Error saving co-occurrence data:', e));
  }, 5000); // Save 5 seconds after last update
}

// Get currently open normalized URLs
async function getOpenNormalizedUrls() {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs
      .map(tab => tab.url)
      .filter(url => url)
      .map(url => normalizeUrlForDedup(url))
      .filter(url => url && url.length > 0);
  } catch (e) {
    console.log('[Jumpware] Error getting open URLs:', e);
    return [];
  }
}

// Calculate cluster boost for a URL based on currently open tabs
function calculateClusterBoost(suggestionUrl, openUrls) {
  if (!coOccurrenceData || !openUrls || openUrls.length === 0) return 0;
  
  const normalizedSuggestion = normalizeUrlForDedup(suggestionUrl);
  const coOccurringUrls = coOccurrenceData[normalizedSuggestion];
  
  if (!coOccurringUrls || Object.keys(coOccurringUrls).length === 0) return 0;
  
  // Find which co-occurring URLs are currently open
  const openCoOccurringUrls = [];
  let totalFrequency = 0;
  let openFrequency = 0;
  
  for (const [coUrl, count] of Object.entries(coOccurringUrls)) {
    totalFrequency += count;
    if (openUrls.includes(coUrl)) {
      openCoOccurringUrls.push(coUrl);
      openFrequency += count;
    }
  }
  
  if (openCoOccurringUrls.length === 0) return 0;
  
  // Calculate cluster size (number of unique co-occurring URLs)
  const clusterSize = Object.keys(coOccurringUrls).length;
  
  // Calculate proportional boost: (openCount / clusterSize) * frequencyWeight
  const openRatio = openCoOccurringUrls.length / clusterSize;
  
  // Frequency weight: how often the open URLs co-occur with this suggestion
  // relative to all co-occurrences
  const frequencyWeight = totalFrequency > 0 ? openFrequency / totalFrequency : 0;
  
  // Boost formula: proportional to cluster participation and frequency
  const boost = openRatio * frequencyWeight * CLUSTER_BOOST_BASE;
  
  return boost;
}

// Snapshot currently open tabs and record co-occurrences
async function snapshotOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const urls = tabs
      .map(tab => tab.url)
      .filter(url => url && (isChromeUrl(url) || (() => {
        try {
          const u = new URL(url);
          return HOST_ALLOW.test(u.hostname);
        } catch {
          return false;
        }
      })()));
    
    if (urls.length > 1) {
      recordCoOccurrence(urls);
    }
    
    lastSnapshotTime = Date.now();
  } catch (e) {
    console.log('[Jumpware] Error snapshotting tabs:', e);
  }
}

// Periodic snapshot scheduler
function scheduleNextSnapshot() {
  const timeSinceLastSnapshot = Date.now() - lastSnapshotTime;
  const delay = Math.max(0, CO_OCCURRENCE_SNAPSHOT_INTERVAL - timeSinceLastSnapshot);
  
  setTimeout(async () => {
    await snapshotOpenTabs();
    scheduleNextSnapshot();
  }, delay);
}

// Track tab changes for immediate co-occurrence updates
let tabChangeTimeout = null;
chrome.tabs.onCreated.addListener(async () => {
  // Debounce: snapshot after 2 seconds of tab activity
  if (tabChangeTimeout) clearTimeout(tabChangeTimeout);
  tabChangeTimeout = setTimeout(async () => {
    await snapshotOpenTabs();
  }, 2000);
});

chrome.tabs.onRemoved.addListener(async () => {
  // Debounce: snapshot after 2 seconds of tab activity
  if (tabChangeTimeout) clearTimeout(tabChangeTimeout);
  tabChangeTimeout = setTimeout(async () => {
    await snapshotOpenTabs();
  }, 2000);
});

// Initialize co-occurrence tracking
loadCoOccurrenceData().then(() => {
  // Take initial snapshot
  snapshotOpenTabs();
  // Schedule periodic snapshots
  scheduleNextSnapshot();
});

// build initial index on install/activate and load into memory
loadIndexToMemory();

