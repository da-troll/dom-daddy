// LinkedIn /in/{slug}/details/experience/ extractor.
//
// Strategy: don't fight LinkedIn's hashed CSS classes. The new SDUI framework
// renders text once (no aria-hidden duplication) and exposes one stable anchor
// per company entry: `[componentkey^="entity-collection-item-"]`. We read each
// entry's innerText and parse it line-by-line into a Profile.
//
// Two innerText shapes (see CLAUDE.md "Known DOM fragility"):
//
//   GROUPED (multi-role at one company):
//     {Company}
//     {EmploymentType} · {TotalDuration}
//     [{Location} · {LocationType}]              ← optional, company-level
//     {Role1Title}
//     {Role1DateRange} · {Role1Duration}
//     [{Role1Location} · {Role1LocationType}]    ← optional, role-level
//     [{Role1Description}]
//     [Skills: a, b, +N skills]
//     {Role2Title}
//     ...
//
//   FLAT (single role):
//     {RoleTitle}
//     {Company} · {EmploymentType}
//     {DateRange} · {Duration}
//     [{Location} · {LocationType}]
//     [{Description}]
//     [ a, b and +N skills]                      ← leading space, no "Skills:" prefix

(async () => {
  const { makeProfile } = await import(chrome.runtime.getURL('src/lib/schema.js'));

  const ENTRY_SELECTOR = '[componentkey^="entity-collection-item-"]';
  const COMPANY_LINK = 'a[href*="/company/"]';

  const EMPLOYMENT_TYPES = [
    'Full-time', 'Part-time', 'Contract', 'Internship',
    'Freelance', 'Self-employed', 'Apprenticeship', 'Seasonal', 'Permanent', 'Temporary',
  ];
  const EMPLOYMENT_RE = new RegExp(`^(${EMPLOYMENT_TYPES.join('|')})\\b`);
  const LOCATION_TYPES = ['Remote', 'Hybrid', 'On-site'];
  const LOCATION_TYPE_RE = new RegExp(`(?:^|\\s·\\s)(${LOCATION_TYPES.join('|')})\\s*$`);
  const DATE_RANGE_RE = /^([A-Z][a-z]{2}\.?\s\d{4}|Present)\s*[-–]\s*([A-Z][a-z]{2}\.?\s\d{4}|Present)(?:\s*·\s*(.+))?$/;
  const SKILLS_RE = /\+(\d+)\s+skills?\s*$/;

  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

  function isExperiencePage() {
    return /^\/in\/[^/]+\/details\/experience\/?$/.test(location.pathname);
  }

  function getSlug() {
    const m = location.pathname.match(/^\/in\/([^/]+)/);
    return m ? m[1] : '';
  }

  function getProfileUrl() {
    const slug = getSlug();
    return slug ? `${location.origin}/in/${slug}/` : location.href;
  }

  function getName() {
    return (document.title || '').replace(/\s*\|\s*LinkedIn\s*$/, '').trim();
  }

  function parseDate(text) {
    if (!text || text === 'Present') return null;
    const m = text.match(/^([A-Z][a-z]{2})\.?\s(\d{4})$/);
    if (!m) return null;
    const mm = MONTHS[m[1]];
    return mm ? `${m[2]}-${mm}` : null;
  }

  function parseLocationLine(line) {
    // "Oslo, Norway · On-site" | "London Area, United Kingdom" | "On-site"
    const parts = line.split('·').map(s => s.trim());
    if (parts.length === 1) {
      if (LOCATION_TYPES.includes(parts[0])) return { locationType: parts[0] };
      return { location: parts[0] };
    }
    const last = parts[parts.length - 1];
    if (LOCATION_TYPES.includes(last)) {
      return { location: parts.slice(0, -1).join(' · '), locationType: last };
    }
    return { location: line };
  }

  function looksLikeLocation(line) {
    if (!line) return false;
    if (DATE_RANGE_RE.test(line)) return false;
    if (EMPLOYMENT_RE.test(line)) return false;
    if (SKILLS_RE.test(line)) return false;
    if (/^Skills:/i.test(line)) return false;
    if (LOCATION_TYPE_RE.test(line)) return true;
    if (LOCATION_TYPES.includes(line.trim())) return true;
    // Plain "City, Region" without a · — accept short comma-separated lines.
    if (/^[A-Z][^.·]{0,80},\s*[A-Z][^.·]{0,80}$/.test(line) && line.length < 100) return true;
    return false;
  }

  function parseSkillsLine(line) {
    // Two formats:
    //   "Skills: A, B, +N skills"        (grouped entries)
    //   " A, B and +N skills"            (flat entries — leading space, "and")
    // We strip prefix/suffix and split on commas.
    let s = line.trim().replace(/^Skills:\s*/i, '');
    const m = s.match(SKILLS_RE);
    let hidden = 0;
    if (m) {
      hidden = parseInt(m[1], 10) || 0;
      s = s.slice(0, m.index).trim();
      // Trailing "X, Y and " or "X, Y," — strip trailing connector.
      s = s.replace(/[,\s]+(?:and)?\s*$/i, '').trim();
    }
    const skills = s.split(/,\s*/).map(x => x.trim()).filter(Boolean);
    return { skills, hiddenSkillCount: hidden };
  }

  function isGroupedShape(lines) {
    // Grouped: line[1] starts with an employment type followed by " · ".
    return lines.length >= 2 && EMPLOYMENT_RE.test(lines[1]) && lines[1].includes('·');
  }

  function parseFlat(lines, ctx) {
    // RoleTitle / Company · EmploymentType / DateRange · Duration / [Location · LocationType] / [Description] / [Skills]
    const role = { title: lines[0] || '', skills: [], hiddenSkillCount: 0 };
    let company = '';
    let employmentType;

    if (lines[1]) {
      const parts = lines[1].split('·').map(s => s.trim());
      company = parts[0] || '';
      if (parts[1] && EMPLOYMENT_RE.test(parts[1])) employmentType = parts[1];
    }

    let i = 2;
    if (lines[i] && DATE_RANGE_RE.test(lines[i])) {
      const m = lines[i].match(DATE_RANGE_RE);
      role.startDateText = m[1];
      role.endDateText = m[2];
      role.startDate = parseDate(m[1]);
      role.endDate = parseDate(m[2]);
      if (m[3]) role.durationText = m[3].trim();
      i++;
    }

    if (lines[i] && looksLikeLocation(lines[i])) {
      Object.assign(role, parseLocationLine(lines[i]));
      i++;
    }

    // Remaining lines: description (possibly multi-line), then maybe skills line at the end.
    const tail = lines.slice(i);
    const skillsIdx = tail.findIndex(l => SKILLS_RE.test(l) || /^Skills:/i.test(l));
    if (skillsIdx >= 0) {
      const parsed = parseSkillsLine(tail[skillsIdx]);
      role.skills = parsed.skills;
      role.hiddenSkillCount = parsed.hiddenSkillCount;
      const desc = tail.slice(0, skillsIdx).join('\n').trim();
      if (desc) role.description = desc;
    } else if (tail.length) {
      role.description = tail.join('\n').trim();
    }

    return {
      company,
      companyUrl: ctx.companyUrl,
      companyId: ctx.companyId,
      logoUrl: ctx.logoUrl,
      ...(employmentType ? { employmentType } : {}),
      roles: [role],
    };
  }

  function parseGrouped(lines, ctx) {
    // Line 0: company. Line 1: "EmploymentType · TotalDuration".
    // After that: optional company-level location, then role blocks separated by date-range lines.
    const company = lines[0] || '';
    const top = lines[1].split('·').map(s => s.trim());
    const employmentType = top[0];
    const totalDurationText = top[1] || undefined;

    let i = 2;
    let companyLocation, companyLocationType;
    if (lines[i] && looksLikeLocation(lines[i])) {
      const loc = parseLocationLine(lines[i]);
      companyLocation = loc.location;
      companyLocationType = loc.locationType;
      i++;
    }

    // Find role boundaries. A role starts on a non-date, non-skills, non-location line
    // and the NEXT line must be a date range. So scan for date-range lines and treat
    // the line before each as a role title.
    const roles = [];
    while (i < lines.length) {
      // Expect role title at lines[i], date range at lines[i+1].
      if (i + 1 >= lines.length) break;
      const title = lines[i];
      if (!DATE_RANGE_RE.test(lines[i + 1])) {
        i++;
        continue;
      }
      const dm = lines[i + 1].match(DATE_RANGE_RE);
      const role = {
        title,
        startDateText: dm[1],
        endDateText: dm[2],
        startDate: parseDate(dm[1]),
        endDate: parseDate(dm[2]),
        ...(dm[3] ? { durationText: dm[3].trim() } : {}),
        skills: [],
        hiddenSkillCount: 0,
      };
      i += 2;

      // Collect lines until next role title (= line followed by a date-range line) or EOF.
      const block = [];
      while (i < lines.length) {
        const isNextRoleTitle = (i + 1 < lines.length) && DATE_RANGE_RE.test(lines[i + 1]) && !DATE_RANGE_RE.test(lines[i]);
        if (isNextRoleTitle) break;
        block.push(lines[i]);
        i++;
      }

      // From block: optional role-level location (first line), optional skills (last skills-line), rest = description.
      let bi = 0;
      if (block[bi] && looksLikeLocation(block[bi])) {
        Object.assign(role, parseLocationLine(block[bi]));
        bi++;
      }
      const remaining = block.slice(bi);
      const skillsIdx = remaining.findIndex(l => SKILLS_RE.test(l) || /^Skills:/i.test(l));
      if (skillsIdx >= 0) {
        const parsed = parseSkillsLine(remaining[skillsIdx]);
        role.skills = parsed.skills;
        role.hiddenSkillCount = parsed.hiddenSkillCount;
        const desc = remaining.slice(0, skillsIdx).join('\n').trim();
        if (desc) role.description = desc;
      } else if (remaining.length) {
        const desc = remaining.join('\n').trim();
        if (desc) role.description = desc;
      }
      roles.push(role);
    }

    return {
      company,
      companyUrl: ctx.companyUrl,
      companyId: ctx.companyId,
      logoUrl: ctx.logoUrl,
      ...(employmentType ? { employmentType } : {}),
      ...(totalDurationText ? { totalDurationText } : {}),
      ...(companyLocation ? { location: companyLocation } : {}),
      ...(companyLocationType ? { locationType: companyLocationType } : {}),
      roles,
    };
  }

  function parseEntry(el) {
    const linkEl = el.querySelector(COMPANY_LINK);
    const companyUrl = linkEl?.href || undefined;
    const companyIdMatch = companyUrl?.match(/\/company\/(\d+)/);
    const companyId = companyIdMatch ? companyIdMatch[1] : undefined;
    const logoUrl = el.querySelector('img')?.src || undefined;
    const ctx = { companyUrl, companyId, logoUrl };

    const lines = (el.innerText || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    if (!lines.length) return null;
    return isGroupedShape(lines) ? parseGrouped(lines, ctx) : parseFlat(lines, ctx);
  }

  function extractLinkedIn() {
    const entries = Array.from(document.querySelectorAll(ENTRY_SELECTOR));
    const experiences = [];
    for (const el of entries) {
      try {
        const exp = parseEntry(el);
        if (exp && exp.roles?.length) experiences.push(exp);
      } catch (err) {
        console.warn('[DOM Daddy] failed to parse experience entry', err, el);
      }
    }

    return makeProfile({
      source: 'linkedin',
      profileUrl: getProfileUrl(),
      slug: getSlug(),
      name: getName(),
      experiences,
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'EXTRACT') {
      try {
        if (!isExperiencePage()) {
          sendResponse({
            ok: false,
            error: 'Not on the experience details page. Open /in/{you}/details/experience/ first.',
          });
          return true;
        }
        sendResponse({ ok: true, data: extractLinkedIn() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return true;
    }
  });
})();
