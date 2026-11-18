'use strict';
/*
 * Sports channel catalog built from the downloaded iptv-org sports.m3u.
 *
 * The playlist is treated as data. Only #EXTINF fields and header *hints*
 * (#EXTINF http-user-agent/referrer, #EXTVLCOPT:http-*, #EXTHTTP, #KODIPROP
 * headers) are read; every other directive is ignored and no header or option
 * is ever applied. Logos and streams are never fetched, nothing is stored, and
 * no source plays until the Watch button is pressed.
 *
 * Output shapes
 *
 * parsePlaylist(text) -> Entry[]   (every entry kept, playlist order)
 *   Entry {
 *     index: number               0-based playlist order
 *     line: number                1-based line of the #EXTINF (or of a bare URL)
 *     title: string               text after the first unquoted comma
 *     duration: number|null
 *     attrs: {[name]: string}     lower-case attribute names, null prototype
 *     tvgId: string               e.g. 'Belarus5.by@HD'
 *     channelId: string           tvg-id before '@', e.g. 'Belarus5.by'
 *     feed: string                tvg-id after '@', e.g. 'HD'
 *     country: string             upper-case code from channelId '.cc', or ''
 *     groupTitle: string
 *     url: string                 URL text exactly as listed; data only, never an href
 *     safeUrl: string             normalized public http(s) URL, '' when unavailable
 *     allowed: boolean            public http(s) host, no credentials
 *     unavailableReason: string   '' when allowed
 *     format: 'hls'|'mp4'|'dash'|'other'|'none'
 *     browserSupported: boolean   allowed and the path ends in .m3u8/.m3u
 *     requiresHeaders: boolean
 *     headerHints: string[]       hinted header names only, e.g. ['referer', 'user-agent']
 *   }
 *
 * groupChannels(entries) -> Channel[]   (sorted by name)
 *   Channel {
 *     key: string                 'id:<channelId>', 'title:<normalized title>' or 'entry:<index>'
 *     id: string                  channelId, '' when grouped by title
 *     name: string                display name from the first entry
 *     country: string             upper-case code or ''
 *     countryName: string
 *     entryCount: number          playlist entries, duplicates included
 *     sources: Source[]           exact-URL duplicates merged within the channel
 *     playableCount: number
 *     searchText: string          normalized name, ID, country and source titles
 *   }
 *   Source {
 *     name, label, url, safeUrl, feed, format, allowed, unavailableReason,
 *     browserSupported, playable, requiresHeaders, headerHints, entryIndexes: number[]
 *   }
 *
 * filterChannels(channels, query, country) -> Channel[] (same objects)
 *   Every query word must occur, ignoring case and diacritics, in the name, ID,
 *   country code/name or a source title. country: '' for all, UNKNOWN_COUNTRY
 *   for channels without a code, otherwise a country code.
 *
 * Browser: window 'channel:select' CustomEvent, detail { name, url, id, country },
 * dispatched only from the Watch button for a browser-supported source.
 */
(() => {
  const UNKNOWN_COUNTRY = 'unknown';
  const MAX_PLAYLIST_CHARS = 20 * 1024 * 1024;
  const CAPTION_NOTE = 'Multilingual catalog; captions are English only.';
  const HEADER_HINTS = new Map([
    ['http-user-agent', 'user-agent'], ['user-agent', 'user-agent'],
    ['http-referrer', 'referer'], ['http-referer', 'referer'], ['referrer', 'referer'], ['referer', 'referer'],
    ['http-origin', 'origin'], ['http-cookie', 'cookie'], ['http-header', 'custom'], ['http-headers', 'custom']
  ]);
  const FOLDED = new Map([['ø', 'o'], ['ł', 'l'], ['đ', 'd'], ['ð', 'd'], ['æ', 'ae'], ['œ', 'oe'], ['ß', 'ss'], ['ı', 'i'], ['þ', 'th'], ['ħ', 'h']]);
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  let regionNames = null;

  function normalizeText(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
      .replace(/[øłđðæœßıþħ]/g, ch => FOLDED.get(ch)).replace(/\s+/g, ' ').trim();
  }

  function plural(count, word, many = word + 's') {
    return `${count} ${count === 1 ? word : many}`;
  }

  // Duration, then key=value / key="value" attributes; the first comma outside
  // quotes starts the title, so commas inside quoted values stay in the value.
  function parseExtinf(body) {
    const attrs = Object.create(null);
    const n = body.length;
    let i = 0;
    const skipSpace = () => { while (i < n && /\s/.test(body[i])) i++; };
    skipSpace();
    let start = i;
    while (i < n && !/[\s,]/.test(body[i])) i++;
    const durationText = body.slice(start, i);
    const duration = durationText && Number.isFinite(Number(durationText)) ? Number(durationText) : null;
    let title = '';
    while (i < n) {
      skipSpace();
      if (i >= n) break;
      if (body[i] === ',') { title = body.slice(i + 1); break; }
      start = i;
      while (i < n && !/[\s,=]/.test(body[i])) i++;
      const key = body.slice(start, i).toLowerCase();
      if (body[i] !== '=') continue;
      i++;
      let value;
      if (body[i] === '"' || body[i] === "'") {
        const quote = body[i++];
        const end = body.indexOf(quote, i);
        value = body.slice(i, end < 0 ? n : end);
        i = end < 0 ? n : end + 1;
      } else {
        start = i;
        while (i < n && !/[\s,]/.test(body[i])) i++;
        value = body.slice(start, i);
      }
      if (/^[a-z0-9_.:-]+$/.test(key) && !(key in attrs)) attrs[key] = value;
    }
    return { duration, attrs, title: title.trim() };
  }

  function addHint(hints, name) {
    const hint = HEADER_HINTS.get(String(name).trim().toLowerCase());
    if (hint) hints.add(hint);
  }

  function isPrivateIPv4(host) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }

  function hostRestriction(host) {
    if (!host) return 'URL has no host';
    if (host.startsWith('[')) return 'IPv6 address literal';
    // The URL parser has already rewritten decimal, octal and hex forms as dotted IPv4.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host) ? 'private, local or reserved IPv4 address' : '';
    if (host === 'localhost' || host.endsWith('.localhost')) return 'local host name';
    if (!host.includes('.')) return 'local network name';
    if (/\.(local|internal|lan|intranet|home\.arpa)$/.test(host)) return 'local network name';
    return '';
  }

  function formatOf(pathname) {
    const path = pathname.toLowerCase();
    if (/\.m3u8?$/.test(path)) return 'hls';
    if (/\.(mp4|m4v)$/.test(path)) return 'mp4';
    if (/\.mpd$/.test(path)) return 'dash';
    return 'other';
  }

  // Only a public http(s) URL ever yields a non-empty safeUrl.
  function classifyUrl(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const unavailable = (reason, format = 'other') =>
      ({ safeUrl: '', allowed: false, unavailableReason: reason, format, browserSupported: false });
    if (!text) return unavailable('no URL listed', 'none');
    if (/[\u0000- \u007f-\u009f\\]/.test(text)) return unavailable('URL contains spaces, control characters or backslashes');
    if (!/^https?:\/\//i.test(text)) return unavailable('not an HTTP or HTTPS URL');
    let parsed;
    try { parsed = new URL(text); } catch (error) { return unavailable('malformed URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return unavailable('not an HTTP or HTTPS URL');
    const format = formatOf(parsed.pathname);
    if (parsed.username || parsed.password) return unavailable('URL contains credentials', format);
    const restriction = hostRestriction(parsed.hostname.toLowerCase().replace(/\.$/, ''));
    if (restriction) return unavailable(restriction, format);
    return { safeUrl: parsed.href, allowed: true, unavailableReason: '', format, browserSupported: format === 'hls' };
  }

  function makeEntry(info, url, index) {
    const attrs = info.attrs;
    const tvgId = (attrs['tvg-id'] || '').trim();
    const at = tvgId.indexOf('@');
    const channelId = (at < 0 ? tvgId : tvgId.slice(0, at)).trim();
    const country = /\.([a-z]{2})$/i.exec(channelId);
    const headerHints = [...info.hints].sort();
    return {
      index, line: info.line,
      title: info.title || (attrs['tvg-name'] || '').trim(),
      duration: info.duration, attrs, tvgId, channelId,
      feed: at < 0 ? '' : tvgId.slice(at + 1).trim(),
      country: country ? country[1].toUpperCase() : '',
      groupTitle: (attrs['group-title'] || '').trim(),
      url, ...classifyUrl(url),
      requiresHeaders: headerHints.length > 0, headerHints
    };
  }

  function parsePlaylist(text) {
    if (typeof text !== 'string') return [];
    const entries = [];
    let pending = null;
    let looseHints = new Set();
    const finish = (url, line) => {
      const info = pending || { title: '', duration: null, attrs: Object.create(null), line, hints: new Set() };
      for (const hint of looseHints) info.hints.add(hint);
      entries.push(makeEntry(info, url, entries.length));
      pending = null;
      looseHints = new Set();
    };
    text.replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      if (line[0] !== '#') { finish(line, i + 1); return; }
      const directive = line.slice(0, line.indexOf(':') + 1 || line.length).toUpperCase();
      const hints = pending ? pending.hints : looseHints;
      if (directive === '#EXTINF:') {
        if (pending) finish('', pending.line);
        pending = { ...parseExtinf(line.slice(8)), line: i + 1, hints: new Set() };
        for (const [name, value] of Object.entries(pending.attrs)) if (value.trim()) addHint(pending.hints, name);
      } else if (directive === '#EXTVLCOPT:') {
        const option = line.slice(11);
        addHint(hints, option.includes('=') ? option.slice(0, option.indexOf('=')) : option);
      } else if (directive === '#EXTHTTP:' || (directive === '#KODIPROP:' && /header/i.test(line))) {
        hints.add('custom');
      }
      // #EXTM3U, #EXTGRP and any other directive are ignored.
    });
    if (pending) finish('', pending.line);
    return entries;
  }

  // Strips only trailing resolution and [status] tags: 'CRTV (Chile) (720p)' -> 'CRTV (Chile)'.
  function cleanName(title) {
    const original = String(title || '').trim();
    let name = original;
    let previous;
    do {
      previous = name;
      name = name.replace(/\s*(\[[^[\]]*\]|\(\d{3,4}[pi]\))\s*$/i, '').trim();
    } while (name !== previous);
    return name || original;
  }

  function countryDisplayName(code) {
    const upper = String(code || '').toUpperCase();
    if (!upper || upper === UNKNOWN_COUNTRY.toUpperCase()) return 'Unknown country';
    if (!/^[A-Z]{2}$/.test(upper)) return upper;
    try {
      if (regionNames === null) {
        regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : false;
      }
      const name = regionNames && regionNames.of(upper === 'UK' ? 'GB' : upper);
      if (name) return name;
    } catch (error) {
      regionNames = regionNames || false;
    }
    return upper;
  }

  function sourceLabel(source) {
    let label = source.name;
    if (source.feed && !normalizeText(label).includes(normalizeText(source.feed))) label += ` [${source.feed}]`;
    const notes = [];
    if (!source.allowed) notes.push('Unavailable: ' + source.unavailableReason);
    else if (!source.browserSupported) notes.push('Unsupported here');
    if (source.allowed && source.requiresHeaders) notes.push('May require headers');
    if (source.entryIndexes.length > 1) notes.push(`listed ${source.entryIndexes.length}×`);
    return notes.length ? `${label} — ${notes.join(' · ')}` : label;
  }

  function groupChannels(entries) {
    const channels = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      const channelId = typeof entry.channelId === 'string' ? entry.channelId : '';
      const title = typeof entry.title === 'string' ? entry.title : '';
      const titleKey = normalizeText(cleanName(title)).replace(/[^\p{L}\p{N}]+/gu, '');
      const key = channelId ? 'id:' + channelId.toLowerCase() : titleKey ? 'title:' + titleKey : 'entry:' + entry.index;
      let channel = channels.get(key);
      if (!channel) {
        channel = {
          key, id: channelId, name: cleanName(title) || channelId || 'Untitled stream',
          country: '', countryName: '', entryCount: 0, sources: [], playableCount: 0, searchText: ''
        };
        channels.set(key, channel);
      }
      if (!channel.country && /^[A-Z]{2}$/.test(entry.country || '')) channel.country = entry.country;
      channel.entryCount++;
      const url = typeof entry.url === 'string' ? entry.url : '';
      const hints = Array.isArray(entry.headerHints) ? entry.headerHints : [];
      const duplicate = url && channel.sources.find(source => source.url === url);
      if (duplicate) {
        duplicate.entryIndexes.push(entry.index);
        for (const hint of hints) if (!duplicate.headerHints.includes(hint)) duplicate.headerHints.push(hint);
        duplicate.requiresHeaders = duplicate.headerHints.length > 0;
        continue;
      }
      // Re-classify rather than trusting fields supplied by the caller.
      const access = classifyUrl(url);
      channel.sources.push({
        name: title || channel.name, label: '', url, safeUrl: access.safeUrl,
        feed: typeof entry.feed === 'string' ? entry.feed : '', format: access.format,
        allowed: access.allowed, unavailableReason: access.unavailableReason,
        browserSupported: access.browserSupported, playable: access.browserSupported,
        requiresHeaders: hints.length > 0, headerHints: [...hints], entryIndexes: [entry.index]
      });
    }
    const list = [...channels.values()];
    for (const channel of list) {
      channel.countryName = channel.country ? countryDisplayName(channel.country) : 'Unknown country';
      channel.playableCount = channel.sources.filter(source => source.playable).length;
      for (const source of channel.sources) source.label = sourceLabel(source);
      channel.searchText = normalizeText([
        channel.name, channel.id, channel.country, channel.country ? channel.countryName : '',
        ...channel.sources.map(source => source.name)
      ].join(' '));
    }
    return list.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
  }

  function filterChannels(channels, query, country) {
    const words = normalizeText(query).split(' ').filter(Boolean);
    const code = typeof country === 'string' ? country.trim() : '';
    return (Array.isArray(channels) ? channels : []).filter(channel => {
      if (!channel) return false;
      if (code === UNKNOWN_COUNTRY ? channel.country : code && code.toUpperCase() !== channel.country) return false;
      const text = channel.searchText || normalizeText(`${channel.name} ${channel.id} ${channel.country}`);
      return words.every(word => text.includes(word));
    });
  }

  function countryOptions(channels) {
    const counts = new Map();
    for (const channel of channels) {
      const code = channel.country || UNKNOWN_COUNTRY;
      counts.set(code, (counts.get(code) || 0) + 1);
    }
    return [...counts].map(([code, count]) => ({ code, name: countryDisplayName(code), count }))
      .sort((a, b) => (a.code === UNKNOWN_COUNTRY) - (b.code === UNKNOWN_COUNTRY) || collator.compare(a.name, b.name));
  }

  function summarize(channels) {
    return channels.reduce((total, channel) => ({
      channels: total.channels + 1,
      entries: total.entries + channel.entryCount,
      sources: total.sources + channel.sources.length,
      playable: total.playable + channel.playableCount
    }), { channels: 0, entries: 0, sources: 0, playable: 0 });
  }

  function sourceAdvice(source) {
    if (!source) return 'No listed source is usable in this browser.';
    if (!source.allowed) return `Unavailable here: ${source.unavailableReason}.`;
    if (!source.browserSupported) {
      return 'This URL is not identified as HLS, so this player cannot open it. A compatible external player may support its format; availability is unverified.';
    }
    if (source.requiresHeaders) {
      return 'May require headers that browsers cannot send; if it fails, try sports.m3u in VLC. Press Watch to try.';
    }
    return 'HLS link listed by iptv-org, not verified; it may be offline or geo-blocked. Press Watch to play.';
  }

  function formatCheckedAt(value) {
    const date = new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(date) + ' IST';
  }

  function describeMetadata(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return 'Catalog metadata unavailable; showing the local sports.m3u copy.';
    }
    const parts = [];
    if (typeof meta.source_url === 'string' && meta.source_url.trim()) parts.push('Source: ' + meta.source_url.trim().slice(0, 300));
    const checked = formatCheckedAt(meta.checked_at);
    parts.push(checked ? 'Checked ' + checked : 'Check time unknown');
    if (Number.isFinite(meta.entries) && Number.isFinite(meta.channels)) {
      parts.push(`download listed ${plural(meta.entries, 'entry', 'entries')} for ${plural(meta.channels, 'channel')}`);
    }
    return parts.join(' · ');
  }

  function channelOptionText(channel) {
    const playable = channel.playableCount ? `${channel.playableCount} HLS` : 'none for browser';
    return `${channel.name} · ${channel.country || '—'} · ${plural(channel.sources.length, 'source')}, ${playable}`;
  }

  // Guide broadcasts identify a channel/region, not a regional or time-shifted
  // variant within it. Only unspecified or quality-only feed tags can match.
  function isGuideSource(source) {
    return Boolean(source && source.playable && /^(?:SD|HD|FHD|UHD|4K|8K)?$/i.test(source.feed || ''));
  }

  function initBrowser(doc, win) {
    const ids = {
      section: 'sports-catalog', search: 'sports-search', country: 'sports-country', channels: 'sports-channels',
      stream: 'sports-stream', watch: 'sports-watch', count: 'sports-count', selection: 'sports-selection',
      loaded: 'sports-loaded', error: 'sports-error'
    };
    const ui = {};
    for (const [name, id] of Object.entries(ids)) ui[name] = doc.getElementById(id);
    if (Object.values(ui).some(node => !node) || ui.section.dataset.sportsCatalog) return Promise.resolve(null);
    ui.section.dataset.sportsCatalog = 'loading';

    const state = { channels: [], visible: [], totals: summarize([]) };
    // The showcase uses synthetic playlist data.
    const checkedAt = 0;
    const sampledFeeds = [];
    const option = (text, value) => {
      const node = doc.createElement('option');
      node.textContent = text;
      node.value = value;
      return node;
    };
    const setListEnabled = enabled => {
      ui.channels.disabled = ui.stream.disabled = !enabled;
      if (!enabled) ui.watch.disabled = true;
    };
    const currentChannel = () => state.visible.find(channel => channel.key === ui.channels.value) || null;
    const currentSource = () => {
      const channel = currentChannel();
      return channel && ui.stream.value !== '' ? channel.sources[Number(ui.stream.value)] || null : null;
    };

    const updateCount = () => {
      const all = state.totals;
      const shown = summarize(state.visible);
      let text = `${plural(all.channels, 'channel')} · ${plural(all.entries, 'source entry', 'source entries')} (listed by iptv-org, not verified)`;
      if (all.entries !== all.sources) text += ` · ${plural(all.entries - all.sources, 'duplicate URL')} merged`;
      ui.count.textContent = `${text} · Showing ${shown.channels} of ${all.channels} channels, ${shown.entries} entries`;
    };

    const updateSelection = () => {
      const channel = currentChannel();
      const source = currentSource();
      ui.watch.disabled = !(source && source.playable);
      if (doc.getElementById('sports-schedule')) win.dispatchEvent(new win.CustomEvent('sports:catalog-selection'));
      if (!channel) {
        ui.selection.textContent = state.visible.length ? 'Choose a channel.' : '';
        return;
      }
      const position = source ? `source ${channel.sources.indexOf(source) + 1} of ${channel.sources.length}` : plural(channel.sources.length, 'source');
      ui.selection.textContent = `${channel.name} · ${channel.countryName} · ${position}. ${sourceAdvice(source)} ${CAPTION_NOTE}`;
    };

    const renderStreams = preferred => {
      const channel = currentChannel();
      if (!channel) {
        ui.stream.replaceChildren();
        ui.stream.disabled = true;
        updateSelection();
        return;
      }
      ui.stream.replaceChildren(...channel.sources.map((source, i) => {
        const node = option(`${i + 1}. ${source.label}`, String(i));
        node.disabled = !source.allowed;
        return node;
      }));
      ui.stream.disabled = false;
      const kept = preferred ? Number(preferred) : -1;
      let index = channel.sources[kept] && channel.sources[kept].allowed ? kept : channel.sources.findIndex(source => source.playable);
      if (index < 0) index = channel.sources.findIndex(source => source.allowed);
      // An all-unavailable channel shows its first source so the reason stays visible.
      ui.stream.value = String(Math.max(index, 0));
      updateSelection();
    };

    const applyFilter = () => {
      const previous = ui.channels.value;
      const previousStream = ui.stream.value;
      state.visible = filterChannels(state.channels, ui.search.value, ui.country.value);
      ui.channels.replaceChildren(...state.visible.map(channel => option(channelOptionText(channel), channel.key)));
      updateCount();
      if (!state.visible.length) {
        setListEnabled(false);
        ui.stream.replaceChildren();
        ui.selection.textContent = 'No channels match this search and country.';
        return;
      }
      ui.channels.disabled = false;
      const kept = state.visible.some(channel => channel.key === previous);
      ui.channels.value = kept ? previous : state.visible[0].key;
      renderStreams(kept ? previousStream : '');
    };

    const populateCountries = () => {
      const countries = countryOptions(state.channels);
      const current = ui.country.value;
      ui.country.replaceChildren(option('All countries', ''), ...countries.map(country => option(
        country.code === UNKNOWN_COUNTRY ? `${country.name} · ${country.count}` : `${country.name} (${country.code}) · ${country.count}`,
        country.code
      )));
      ui.country.value = countries.some(country => country.code === current) ? current : '';
    };

    ui.search.addEventListener('input', applyFilter);
    ui.country.addEventListener('change', applyFilter);
    ui.channels.addEventListener('change', () => renderStreams(''));
    ui.stream.addEventListener('change', updateSelection);
    // Catalogue membership/format only: this never probes or promises a live feed.
    const findChannel = channelId => typeof channelId === 'string'
      ? state.channels.find(item => item.id.toLowerCase() === channelId.toLowerCase()) : null;
    win.getSportsChannelStatus = channelId => {
      const phase = ui.section.dataset.sportsCatalog;
      if (phase !== 'ready') return { status: phase === 'error' ? 'error' : 'loading' };
      const channel = findChannel(channelId);
      if (!channel) return { status: 'missing' };
      if (!channel.sources.some(item => item.playable)) return { status: 'unsupported' };
      return { status: channel.sources.some(isGuideSource) ? 'available' : 'regional' };
    };
    win.selectSportsChannel = channelId => {
      if (win.getSportsChannelStatus(channelId).status !== 'available') return false;
      const channel = findChannel(channelId);
      ui.search.value = ''; ui.country.value = ''; applyFilter();
      ui.channels.value = channel.key; renderStreams(String(channel.sources.findIndex(isGuideSource)));
      const library = doc.getElementById('channel-library');
      if (library) library.open = true;
      ui.stream.scrollIntoView?.({block:'center', behavior:'smooth'});
      ui.stream.focus?.({preventScroll:true});
      return true;
    };
    ui.watch.addEventListener('click', () => {
      const channel = currentChannel();
      const source = currentSource();
      const check = source ? classifyUrl(source.url) : null;
      if (!channel || !check || !check.browserSupported) {
        ui.watch.disabled = true;
        return;
      }
      win.dispatchEvent(new win.CustomEvent('channel:select', {
        detail: { name: channel.name, url: check.safeUrl, id: channel.id, country: channel.country }
      }));
      ui.selection.textContent = `Sent ${channel.name} (source ${channel.sources.indexOf(source) + 1}) to the player. ` +
        `Listed streams are not verified and may be offline. ${CAPTION_NOTE}`;
    });

    const renderSampledFeeds = () => {
      const strip=doc.getElementById('checked-feeds');
      const buttons=doc.getElementById('checked-feed-buttons');
      const timestamp=doc.getElementById('checked-feeds-time');
      if(!strip || !buttons || !timestamp)return;
      buttons.replaceChildren();
      // A dated sample must not remain a current recommendation indefinitely.
      const age=Date.now()-checkedAt;
      strip.hidden=age<0 || age>24*60*60*1000;
      if(strip.hidden)return;
      win.setTimeout?.(()=>{strip.hidden=true;},24*60*60*1000-age);
      timestamp.textContent='Sampled '+formatCheckedAt(checkedAt)+'. Other catalogue feeds have not been tested.';
      for(const tested of sampledFeeds) {
        const channel=state.channels.find(item=>item.id===tested.id);
        const sourceIndex=channel?.sources.findIndex(item=>item.safeUrl===tested.url && item.playable) ?? -1;
        if(sourceIndex<0)continue;
        const button=doc.createElement('button');button.type='button';button.textContent=tested.label;
        button.addEventListener('click',()=>{
          ui.search.value='';ui.country.value='';applyFilter();
          ui.channels.value=channel.key;renderStreams(String(sourceIndex));
          ui.watch.click();
        });
        buttons.append(button);
      }
      if(!buttons.childElementCount)strip.hidden=true;
    };

    const fetchText = async path => {
      const response = await win.fetch(path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_PLAYLIST_CHARS) throw new Error(`${path} is too large`);
      return text;
    };

    ui.error.hidden = true;
    ui.error.textContent = '';
    setListEnabled(false);
    ui.search.disabled = ui.country.disabled = true;
    ui.count.textContent = 'Loading sports channels…';
    ui.section.setAttribute('aria-busy', 'true');

    return Promise.allSettled([fetchText('/sports.m3u'), fetchText('/sports-catalog-meta.json').then(text => JSON.parse(text))])
      .then(([playlist, meta]) => {
        ui.loaded.textContent = describeMetadata(meta.status === 'fulfilled' ? meta.value : null);
        if (playlist.status !== 'fulfilled') throw playlist.reason;
        state.channels = groupChannels(parsePlaylist(playlist.value));
        state.totals = summarize(state.channels);
        if (!state.channels.length) throw new Error('the playlist has no channel entries');
        populateCountries();
        ui.search.disabled = ui.country.disabled = false;
        applyFilter();
        renderSampledFeeds();
        ui.section.dataset.sportsCatalog = 'ready';
        if (doc.getElementById('sports-schedule')) win.dispatchEvent(new win.CustomEvent('sports:catalog-state'));
        return state;
      })
      .catch(error => {
        const strip=doc.getElementById('checked-feeds');if(strip)strip.hidden=true;
        state.channels = [];
        state.visible = [];
        state.totals = summarize([]);
        ui.channels.replaceChildren();
        ui.stream.replaceChildren();
        setListEnabled(false);
        ui.error.textContent = `Sports catalog could not be loaded: ${(error && error.message) || 'unknown error'}. The match player is unaffected.`;
        ui.error.hidden = false;
        ui.count.textContent = 'No sports channels loaded.';
        ui.selection.textContent = '';
        ui.section.dataset.sportsCatalog = 'error';
        if (doc.getElementById('sports-schedule')) win.dispatchEvent(new win.CustomEvent('sports:catalog-state'));
        return null;
      })
      .finally(() => ui.section.removeAttribute('aria-busy'));
  }

  const api = Object.freeze({
    UNKNOWN_COUNTRY, parsePlaylist, filterChannels, groupChannels, classifyUrl, normalizeText,
    countryDisplayName, countryOptions, summarize, sourceAdvice, formatCheckedAt, describeMetadata, isGuideSource, initBrowser
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    window.SportsCatalog = api;
    const start = () => initBrowser(document, window);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})();
