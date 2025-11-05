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

// --- restrict to Docs + GitHub only ---
const HOST_ALLOW = /(^|\.)docs\.google\.com$|(^|\.)github\.com$/i;

const normalizeItem = (url, title = "") => {
  try {
    const u = new URL(url);
    if (!HOST_ALLOW.test(u.hostname)) return null;

    let label = title || url;
    let kind = "Other";

    if (/docs\.google\.com/i.test(u.hostname)) {
      if (u.pathname.startsWith("/document/")) kind = "Google Doc";
      else if (u.pathname.startsWith("/spreadsheets/")) kind = "Google Sheet";
      else if (u.pathname.startsWith("/presentation/")) kind = "Google Slides";
      else kind = "Google Docs";

      // Fall back to a human-ish ID if no title
      label = title && title.trim() ? title : `[${kind}] ${u.pathname.split("/")[3] || ""}`;
    } else if (/github\.com/i.test(u.hostname)) {
      const [, owner, repo] = u.pathname.split("/");
      if (owner && repo) { kind = "GitHub"; label = title && title.trim() ? title : `${owner}/${repo}`; }
      else kind = "GitHub";
    }

    return { url: u.toString(), title: label, host: u.hostname, kind };
  } catch { return null; }
};

const dedupeByUrl = (arr) => {
  const seen = new Set(); const out = [];
  for (const x of arr) if (x && !seen.has(x.url)) { seen.add(x.url); out.push(x); }
  return out;
};

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
  await chrome.storage.local.set({ index, index_timestamp: Date.now() });
  return index;
}

async function getIndexFresh() {
  const { index, index_timestamp } = await chrome.storage.local.get(["index", "index_timestamp"]);
  if (!index || !index_timestamp || (Date.now() - index_timestamp) > 5 * 60 * 1000) {
    return await buildIndex();
  }
  return index;
}

// refresh periodically as you browse (rate-limited)
chrome.history.onVisited.addListener(async () => {
  const { index_timestamp } = await chrome.storage.local.get("index_timestamp");
  if (!index_timestamp || (Date.now() - index_timestamp) > 60 * 1000) buildIndex();
});

// --- omnibox wiring ---
chrome.omnibox.onInputStarted.addListener(() => {
  chrome.omnibox.setDefaultSuggestion({
    description: "Type a doc/repo name (e.g., ; proposal draft  ·  ; owner/repo)"
  });
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const idx = await getIndexFresh();
  const q = text.trim();
  const scored = idx.map(item => {
    const hay = `${item.title} ${item.url} ${item.kind}`;
    return { item, score: fuzzyScore(q, hay) };
  }).filter(x => x.score !== -Infinity);

  scored.sort((a, b) => b.score - a.score);

  suggest(scored.slice(0, 6).map(({ item }) => ({
    content: item.url,
    description: `${item.kind}: ${escapeForOmnibox(item.title)} — <url>${escapeForOmnibox(item.url)}</url>`
  })));
});

// open picked suggestion (or fall back to web search if user typed a raw string)
chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let url;
  
  // If text is already a URL (user selected a suggestion), use it
  if (/^https?:\/\//i.test(text)) {
    url = text;
  } else {
    // Otherwise, compute suggestions and use the first match
    const idx = await getIndexFresh();
    const q = text.trim();
    const scored = idx.map(item => {
      const hay = `${item.title} ${item.url} ${item.kind}`;
      return { item, score: fuzzyScore(q, hay) };
    }).filter(x => x.score !== -Infinity);

    scored.sort((a, b) => b.score - a.score);
    
    // Use first suggestion if available, otherwise fall back to Google search
    url = scored.length > 0 
      ? scored[0].item.url 
      : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  }

  if (disposition === "currentTab") chrome.tabs.update({ url });
  else if (disposition === "newForegroundTab") chrome.tabs.create({ url });
  else chrome.tabs.create({ url, active: false });
});

// utility: minimal escaping so titles/urls render safely in suggestions
function escapeForOmnibox(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// build initial index on install/activate
buildIndex();

