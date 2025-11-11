// Content script for on-screen links and OTP detection

// --- CTA words for link scoring ---
const CTA_WORDS = [
  "open", "test", "try", "continue", "verify", "sign in", "sign out", "sign up",
  "start", "launch", "go", "view", "next", "demo", "click", "get started",
  "learn more", "read more", "download", "install"
];

// --- Verification code phrases ---
const VERIFICATION_PHRASES = [
  "verification code", "authentication code", "enter the code", "we emailed a code",
  "two-factor", "one-time", "security code", "verification", "authentication"
];

const EMAIL_MENTIONS = [
  "email", "emailed", "inbox", "mail"
];

const SMS_MENTIONS = [
  "text message", "sms", "text", "phone number"
];

// --- Collect visible links from viewport ---
function collectVisibleLinks() {
  const startTime = performance.now();
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2
  };

  const candidates = [];
  const seenUrls = new Set();
  const currentUrl = window.location.href.split('#')[0]; // Remove hash

  // Get all anchor elements
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  
  // Get focusable elements that might navigate (buttons, divs with click handlers)
  const focusables = Array.from(document.querySelectorAll(
    'button, [role="button"], [role="link"], [onclick], [data-href]'
  ));

  // Combine and process
  const allElements = [...anchors, ...focusables];

  for (const el of allElements) {
    try {
      // Get href or data-href
      let href = el.href || el.getAttribute('href') || el.getAttribute('data-href');
      if (!href) continue;

      // Skip javascript: links
      if (href.startsWith('javascript:')) continue;

      // Skip hash-only anchors (same page)
      try {
        const url = new URL(href, window.location.href);
        if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash && !url.hash.startsWith('#')) {
          continue;
        }
        href = url.toString();
      } catch {
        continue;
      }

      // De-dupe identical hrefs
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);

      // Check if element is in viewport
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 14) continue; // Non-trivial geometry

      // Check viewport intersection
      const inViewport = rect.top < viewport.height && 
                        rect.bottom > 0 && 
                        rect.left < viewport.width && 
                        rect.right > 0;
      if (!inViewport) continue;

      // Check computed styles
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || 
          style.display === 'none' || 
          parseFloat(style.opacity) <= 0) continue;

      // Get text content
      const text = (el.textContent || el.innerText || '').trim();
      
      // Score the link
      let score = 0;

      // CTA language boost
      const lowerText = text.toLowerCase();
      for (const cta of CTA_WORDS) {
        if (lowerText.includes(cta.toLowerCase())) {
          score += 20;
          break;
        }
      }

      // Font size prominence
      const fontSize = parseFloat(style.fontSize) || 14;
      score += Math.min(fontSize / 2, 10);

      // Distance from viewport center
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = Math.sqrt(
        Math.pow(centerX - viewport.centerX, 2) + 
        Math.pow(centerY - viewport.centerY, 2)
      );
      score += Math.max(0, (viewport.width + viewport.height - distance) / 10);

      // Button hints
      const className = (el.className || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      if (className.includes('btn') || className.includes('button') || 
          className.includes('primary') || className.includes('cta') ||
          id.includes('btn') || id.includes('button') || id.includes('cta')) {
        score += 15;
      }

      // Context hints (matches page title/domain)
      const pageTitle = document.title.toLowerCase();
      const domain = window.location.hostname.toLowerCase();
      if (lowerText && (pageTitle.includes(lowerText) || domain.includes(lowerText.split(' ')[0]))) {
        score += 10;
      }

      // Check if near headings (hero areas)
      let parent = el.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        if (parent.tagName && ['H1', 'H2', 'H3'].includes(parent.tagName)) {
          score += 10;
          break;
        }
        parent = parent.parentElement;
      }

      // Negative weights
      // Footer links
      let checkEl = el;
      for (let i = 0; i < 10 && checkEl; i++) {
        const tag = checkEl.tagName?.toLowerCase();
        const cls = (checkEl.className || '').toLowerCase();
        if (tag === 'footer' || cls.includes('footer') || id.includes('footer')) {
          score -= 30;
          break;
        }
        checkEl = checkEl.parentElement;
      }

      // Nav bars with many siblings
      if (el.parentElement) {
        const siblings = Array.from(el.parentElement.children).filter(
          child => child.tagName === el.tagName
        );
        if (siblings.length > 5) {
          const navEl = el.closest('nav, [role="navigation"], header');
          if (navEl) score -= 20;
        }
      }

      // Same as current URL
      if (href === currentUrl) score -= 15;

      candidates.push({
        url: href,
        text: text || href,
        score: score
      });
    } catch (e) {
      // Skip elements that cause errors
      continue;
    }
  }

  // Sort by score and return top 6
  candidates.sort((a, b) => b.score - a.score);
  const topLinks = candidates.slice(0, 6);

  const elapsed = performance.now() - startTime;
  console.log(`[Jumpware] Collected ${topLinks.length} visible links in ${elapsed.toFixed(2)}ms`);

  return topLinks;
}

// --- Detect OTP/verification code screen ---
function detectOTPScreen() {
  const hostname = window.location.hostname;
  let confidence = 0;
  const signals = {
    hasCodeInput: false,
    hasVerificationText: false,
    hasEmailMention: false,
    hasSMSPreference: false
  };

  // Scan for code input fields
  const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    const name = (input.getAttribute('name') || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const type = (input.type || '').toLowerCase();
    const pattern = input.getAttribute('pattern') || '';
    const maxLength = input.getAttribute('maxlength');

    return (
      autocomplete === 'one-time-code' ||
      name.includes('otp') || name.includes('code') || name.includes('twofactor') || 
      name.includes('2fa') || name.includes('verification') ||
      id.includes('otp') || id.includes('code') || id.includes('twofactor') || 
      id.includes('2fa') || id.includes('verification') ||
      (pattern && /^\d{6,8}$/.test(pattern.replace(/[^\d]/g, ''))) ||
      (maxLength && parseInt(maxLength) >= 6 && parseInt(maxLength) <= 8 && type === 'text')
    );
  });

  if (codeInputs.length > 0) {
    signals.hasCodeInput = true;
    confidence += 50;
  }

  // Scan for verification text cues
  const bodyText = document.body.innerText || document.body.textContent || '';
  const lowerBodyText = bodyText.toLowerCase();

  for (const phrase of VERIFICATION_PHRASES) {
    if (lowerBodyText.includes(phrase.toLowerCase())) {
      signals.hasVerificationText = true;
      confidence += 30;
      break;
    }
  }

  // Check for email mentions
  for (const emailPhrase of EMAIL_MENTIONS) {
    if (lowerBodyText.includes(emailPhrase.toLowerCase())) {
      signals.hasEmailMention = true;
      confidence += 20;
      break;
    }
  }

  // Check for SMS preference (negative signal)
  let smsCount = 0;
  for (const smsPhrase of SMS_MENTIONS) {
    if (lowerBodyText.includes(smsPhrase.toLowerCase())) {
      smsCount++;
    }
  }
  if (smsCount > 0 && !signals.hasEmailMention) {
    signals.hasSMSPreference = true;
    confidence -= 40;
  }

  // Check page title
  const pageTitle = document.title.toLowerCase();
  if (pageTitle.includes('verify') || pageTitle.includes('verification') || 
      pageTitle.includes('security code') || pageTitle.includes('two-factor')) {
    confidence += 15;
  }

  // Check headings
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  for (const heading of headings) {
    const headingText = (heading.textContent || '').toLowerCase();
    for (const phrase of VERIFICATION_PHRASES) {
      if (headingText.includes(phrase.toLowerCase())) {
        confidence += 10;
        break;
      }
    }
  }

  return {
    confidence,
    signals,
    hostname,
    detected: confidence >= 70 && signals.hasCodeInput
  };
}

// --- Extract page content for indexing ---
function extractPageContent() {
  const url = window.location.href;
  const hostname = window.location.hostname;
  
  // Special handling for Google Docs
  if (hostname.includes('docs.google.com')) {
    return extractGoogleDocsContent();
  }
  
  // Generic page extraction
  return extractGenericPageContent();
}

function extractGoogleDocsContent() {
  // Try to find the actual document title
  // Google Docs stores it in various places depending on the UI state
  let title = document.title;
  
  // Try common selectors for Google Docs title
  const titleSelectors = [
    '[data-title]',
    '.docs-title-input',
    '[aria-label*="title" i]',
    'input[placeholder*="title" i]',
    '.kix-appview-editor'
  ];
  
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const candidate = el.value || el.textContent || el.getAttribute('data-title');
      if (candidate && candidate.trim() && candidate !== 'Untitled document') {
        title = candidate.trim();
        break;
      }
    }
  }
  
  // Extract document text content
  // Google Docs content is in specific containers
  const contentSelectors = [
    '.kix-page-content-wrapper',
    '.kix-page-content',
    '[role="textbox"]',
    '.kix-appview-editor'
  ];
  
  let textContent = '';
  for (const selector of contentSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      textContent = el.innerText || el.textContent || '';
      if (textContent.trim().length > 50) { // Only use if substantial content
        break;
      }
    }
  }
  
  // Fallback: get all text from body, but filter out UI elements
  if (!textContent || textContent.length < 50) {
    const body = document.body.cloneNode(true);
    // Remove common UI elements
    body.querySelectorAll('header, nav, footer, [role="toolbar"], [role="menu"]').forEach(el => el.remove());
    textContent = body.innerText || body.textContent || '';
  }
  
  // Limit content size for storage (first ~5000 chars should be enough for search)
  const maxContentLength = 5000;
  if (textContent.length > maxContentLength) {
    textContent = textContent.substring(0, maxContentLength) + '...';
  }
  
  return {
    title: title || document.title,
    content: textContent.trim(),
    url: window.location.href,
    extractedAt: Date.now()
  };
}

function extractGenericPageContent() {
  // Get page title
  let title = document.title;
  
  // Try to get better title from meta tags
  const metaTitle = document.querySelector('meta[property="og:title"]') || 
                    document.querySelector('meta[name="title"]');
  if (metaTitle) {
    const metaValue = metaTitle.getAttribute('content') || metaTitle.getAttribute('value');
    if (metaValue && metaValue.trim()) {
      title = metaValue.trim();
    }
  }
  
  // Extract main content
  // Try to find main content area
  const mainSelectors = [
    'main',
    '[role="main"]',
    'article',
    '.content',
    '#content',
    '.main-content',
    '.post-content',
    '.entry-content'
  ];
  
  let textContent = '';
  for (const selector of mainSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      textContent = el.innerText || el.textContent || '';
      if (textContent.trim().length > 100) {
        break;
      }
    }
  }
  
  // Fallback: get body text but remove navigation, headers, footers
  if (!textContent || textContent.length < 100) {
    const body = document.body.cloneNode(true);
    // Remove common non-content elements
    body.querySelectorAll('header, nav, footer, aside, script, style, .nav, .navigation, .menu, .sidebar').forEach(el => el.remove());
    textContent = body.innerText || body.textContent || '';
  }
  
  // Get headings for context
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5);
  const headingText = headings.map(h => h.textContent?.trim()).filter(Boolean).join(' | ');
  
  // Limit content size
  const maxContentLength = 5000;
  if (textContent.length > maxContentLength) {
    textContent = textContent.substring(0, maxContentLength) + '...';
  }
  
  return {
    title: title || document.title,
    content: textContent.trim(),
    headings: headingText,
    url: window.location.href,
    extractedAt: Date.now()
  };
}

// --- Build Gmail search URL ---
function buildGmailSearchURL(hostname, signals) {
  const baseUrl = 'https://mail.google.com/mail/u/0/#search/';
  
  // Hostname-specific mappings
  const hostnameMappings = {
    'github.com': {
      from: 'from:(noreply@github.com OR accounts-noreply@github.com)',
      subjects: ['verification code', 'authentication code', 'security code']
    },
    'accounts.google.com': {
      from: 'from:(no-reply@accounts.google.com OR accounts-noreply@google.com)',
      subjects: ['verification code', 'security code']
    },
    'discord.com': {
      from: 'from:(noreply@discord.com)',
      subjects: ['verification code', 'verification']
    },
    'slack.com': {
      from: 'from:(noreply@slack.com)',
      subjects: ['verification code', 'verification']
    },
    'notion.so': {
      from: 'from:(noreply@notion.so)',
      subjects: ['verification code', 'verification']
    },
    'amazon.com': {
      from: 'from:(account-update@amazon.com OR no-reply@amazon.com)',
      subjects: ['verification code', 'verification']
    },
    'microsoftonline.com': {
      from: 'from:(no-reply@microsoft.com)',
      subjects: ['verification code', 'verification']
    },
    'dropbox.com': {
      from: 'from:(no-reply@dropbox.com)',
      subjects: ['verification code', 'verification']
    },
    'stripe.com': {
      from: 'from:(no-reply@stripe.com)',
      subjects: ['verification code', 'verification']
    },
    'figma.com': {
      from: 'from:(no-reply@figma.com)',
      subjects: ['verification code', 'verification']
    }
  };

  // Find matching hostname (exact or domain match)
  let mapping = null;
  for (const [domain, config] of Object.entries(hostnameMappings)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      mapping = config;
      break;
    }
  }

  // Build search query
  const queryParts = ['in:anywhere', 'newer_than:2h'];
  
  if (mapping) {
    queryParts.push(mapping.from);
    const subjectQueries = mapping.subjects.map(s => `subject:"${s}"`).join(' OR ');
    queryParts.push(`(${subjectQueries})`);
  } else {
    // Fallback generic search
    queryParts.push('subject:"verification code" OR subject:"authentication code" OR subject:"Your code"');
  }

  // Gmail search URLs use + for spaces in the hash fragment
  const query = queryParts.join(' ');
  return baseUrl + query.replace(/\s+/g, '+');
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collectVisibleLinks') {
    try {
      const links = collectVisibleLinks();
      sendResponse({ success: true, links });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true; // Async response
  }

  if (request.action === 'detectOTPScreen') {
    try {
      const detection = detectOTPScreen();
      if (detection.detected) {
        const gmailUrl = buildGmailSearchURL(detection.hostname, detection.signals);
        sendResponse({ 
          success: true, 
          detected: true,
          gmailUrl,
          confidence: detection.confidence,
          hostname: detection.hostname
        });
      } else {
        sendResponse({ 
          success: true, 
          detected: false,
          confidence: detection.confidence
        });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true; // Async response
  }

  if (request.action === 'extractPageContent') {
    try {
      const pageData = extractPageContent();
      sendResponse({ success: true, data: pageData });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true; // Async response
  }
});

// --- MutationObserver for SPA route changes ---
let mutationTimeout = null;
const observer = new MutationObserver(() => {
  if (mutationTimeout) clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    // Re-detect on route changes (detection will be requested by background when needed)
    // We don't auto-trigger here, just ensure detection is fresh when requested
  }, 500);
});

// Start observing after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  });
} else {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

