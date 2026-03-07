/**
 * Natural Language Task Parser
 *
 * Uses chrono-node for date/time parsing + custom extraction for:
 *   #project          → TickTick project/list
 *   !priority         → High/Med/Low priority
 *   Recurring         → daily, weekly, monthly keywords
 *   Urgency           → urgent, asap, important, critical
 *
 * Examples (natural language):
 *   "meeting with John tomorrow at 3pm #work urgent"
 *   "call mom next Monday afternoon"
 *   "submit report by March 15th !high"
 *   "gym every day at 7am #health"
 *   "dentist on the 20th at 2:30pm"
 *   "team sync weekly on Monday #work"
 *   "meeting every friday at 11.30 am #work" → title: "meeting"
 */

import * as chrono from 'chrono-node';

// Repeat patterns for TickTick (RRULE format)
const REPEAT_RULES = {
  'daily': 'RRULE:FREQ=DAILY;INTERVAL=1',
  'weekly': 'RRULE:FREQ=WEEKLY;INTERVAL=1',
  'monthly': 'RRULE:FREQ=MONTHLY;INTERVAL=1',
  'weekday': 'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
  'yearly': 'RRULE:FREQ=YEARLY;INTERVAL=1',
};

// Day abbreviations for RRULE BYDAY
const DAY_ABBREV = {
  'sunday': 'SU', 'sun': 'SU',
  'monday': 'MO', 'mon': 'MO',
  'tuesday': 'TU', 'tue': 'TU',
  'wednesday': 'WE', 'wed': 'WE',
  'thursday': 'TH', 'thu': 'TH',
  'friday': 'FR', 'fri': 'FR',
  'saturday': 'SA', 'sat': 'SA',
};

// Fuzzy day matching - common typos and variations
const DAY_FUZZY = {
  // Sunday
  'sund': 'SU', 'sundy': 'SU', 'snday': 'SU', 'su': 'SU',
  // Monday
  'mond': 'MO', 'mondy': 'MO', 'mnday': 'MO', 'mo': 'MO',
  // Tuesday
  'tues': 'TU', 'tuesd': 'TU', 'tusday': 'TU', 'tuseday': 'TU', 'tu': 'TU',
  // Wednesday
  'weds': 'WE', 'wednes': 'WE', 'wensday': 'WE', 'wendsay': 'WE', 'wednsday': 'WE', 'we': 'WE',
  // Thursday
  'thurs': 'TH', 'thur': 'TH', 'thursd': 'TH', 'thursdy': 'TH', 'th': 'TH',
  // Friday
  'frid': 'FR', 'fridy': 'FR', 'firday': 'FR', 'friady': 'FR', 'fr': 'FR',
  // Saturday
  'satur': 'SA', 'saturd': 'SA', 'saturdy': 'SA', 'satrday': 'SA', 'sa': 'SA',
};

/**
 * Get day abbreviation with fuzzy matching
 */
function getDayAbbrev(word) {
  const lower = word.toLowerCase();
  // Exact match first
  if (DAY_ABBREV[lower]) return DAY_ABBREV[lower];
  // Fuzzy match
  if (DAY_FUZZY[lower]) return DAY_FUZZY[lower];
  // Try prefix matching (3+ chars)
  if (lower.length >= 3) {
    for (const [day, abbrev] of Object.entries(DAY_ABBREV)) {
      if (day.startsWith(lower) || lower.startsWith(day.slice(0, 3))) {
        return abbrev;
      }
    }
  }
  return null;
}

// Keywords that trigger recurring
const RECURRING_KEYWORDS = [
  { pattern: /\b(daily|every\s*day)\b/i, type: 'daily' },
  { pattern: /\b(weekly|every\s*week)\b/i, type: 'weekly' },
  { pattern: /\b(monthly|every\s*month)\b/i, type: 'monthly' },
  { pattern: /\b(yearly|every\s*year|annually)\b/i, type: 'yearly' },
  { pattern: /\b(weekday|weekdays|every\s*weekday)\b/i, type: 'weekday' },
];

// Priority mapping
const PRIORITY_MAP = {
  '1': 5, 'high': 5, 'h': 5,
  '2': 3, 'med': 3, 'medium': 3, 'm': 3,
  '3': 1, 'low': 1, 'l': 1,
};

// Urgency keywords that imply high priority
const URGENCY_KEYWORDS = /\b(urgent|asap|critical|important|emergency|immediately|right\s*away)\b/i;

/**
 * Get next occurrence date for a recurring task
 * Used when no explicit date is given
 */
function getNextOccurrence(rrule) {
  const now = new Date();
  
  // Parse BYDAY from RRULE
  const bydayMatch = rrule.match(/BYDAY=([A-Z,]+)/);
  if (bydayMatch) {
    const days = bydayMatch[1].split(',');
    const dayMap = { 'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6 };
    const targetDays = days.map(d => dayMap[d]).filter(d => d !== undefined);
    
    if (targetDays.length > 0) {
      const currentDay = now.getDay();
      // Find the next occurrence
      let minDays = 7;
      for (const target of targetDays) {
        let diff = target - currentDay;
        if (diff <= 0) diff += 7; // Next week if today or past
        if (diff < minDays) minDays = diff;
      }
      const next = new Date(now);
      next.setDate(next.getDate() + minDays);
      next.setHours(9, 0, 0, 0); // Default to 9 AM
      return next;
    }
  }
  
  // Daily - tomorrow
  if (rrule.includes('FREQ=DAILY')) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow;
  }
  
  // Default - tomorrow
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow;
}

/**
 * Format date for TickTick API
 * TickTick expects: "yyyy-MM-dd'T'HH:mm:ssZ" format
 * Example: "2026-03-09T15:00:00+0530"
 */
function formatDateForTickTick(date, hasTime = false) {
  if (!date) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  // Get timezone offset
  const tzOffset = -date.getTimezoneOffset();
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';

  if (hasTime) {
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${tzSign}${tzHours}${tzMinutes}`;
  } else {
    // All-day task - set to midnight
    return `${year}-${month}-${day}T00:00:00${tzSign}${tzHours}${tzMinutes}`;
  }
}

/**
 * Parse task text and extract metadata using chrono-node
 * @param {string} text - Raw task text from Notion
 * @returns {object} - { title, project, dueDate, priority, repeat, ... }
 */
export function parseTask(text) {
  let title = text.trim();
  let tags = [];
  let dueDate = null;
  let dueDateStr = null;
  let hasTime = false;
  let priority = 0;
  let priorityStr = null;
  let repeat = null;
  let repeatFlag = null;

  // Extract #tags (can be multiple: #siemens #meeting #call)
  const tagMatches = title.match(/#(\w+)/g);
  if (tagMatches) {
    tags = tagMatches.map(t => t.slice(1).toLowerCase()); // Remove # and lowercase
    title = title.replace(/#\w+/g, '').trim();
  }

  // Extract !priority (!1, !2, !3, !high, !med, !low)
  const priorityMatch = title.match(/!(\w+)/);
  if (priorityMatch) {
    priorityStr = priorityMatch[1].toLowerCase();
    priority = PRIORITY_MAP[priorityStr] || 0;
    title = title.replace(/!\w+/g, '').trim();
  }

  // Check for urgency keywords (implies high priority)
  if (URGENCY_KEYWORDS.test(title)) {
    if (priority === 0) {
      priority = 5; // High priority
      priorityStr = 'urgent';
    }
    // Remove urgency words from title
    title = title.replace(URGENCY_KEYWORDS, '').trim();
  }

  // Auto-detect recurring from keywords (before date parsing)
  for (const { pattern, type } of RECURRING_KEYWORDS) {
    if (pattern.test(title)) {
      repeat = type;
      repeatFlag = REPEAT_RULES[type];
      // Remove the matched pattern from title
      title = title.replace(pattern, '').trim();
      break;
    }
  }

  // Advanced recurring: "every monday and wednesday", "every tue, thu, sat", etc.
  // Also supports fuzzy day names: "fridy", "wednsday", etc.
  // Match "every" followed by day-like words
  const everyMatch = title.match(/\bevery\s+(.+?)(?=\s+at\s+|\s+#|\s+!|$)/i);
  if (everyMatch && !repeatFlag) {
    const afterEvery = everyMatch[1];
    // Extract potential day words (split by comma, "and", "&", or space)
    const words = afterEvery.split(/[\s,&]+|(?:\s+and\s+)/i).filter(w => w.length >= 2);
    const dayAbbrevs = [];
    const matchedWords = [];
    
    for (const word of words) {
      const abbrev = getDayAbbrev(word);
      if (abbrev && !dayAbbrevs.includes(abbrev)) {
        dayAbbrevs.push(abbrev);
        matchedWords.push(word);
      }
    }
    
    if (dayAbbrevs.length > 0) {
      repeat = 'weekly';
      repeatFlag = `RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=${dayAbbrevs.join(',')}`;
      // Remove "every [matched days]" from title
      const removePattern = new RegExp(`\\bevery\\s+${matchedWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*(?:,|and|&)?\\s*')}\\b`, 'i');
      title = title.replace(removePattern, '').trim();
      // Fallback: remove "every" + all matched words individually
      if (title.includes('every')) {
        title = title.replace(/\bevery\b/i, '').trim();
        for (const w of matchedWords) {
          title = title.replace(new RegExp(`\\b${w}\\b`, 'i'), '').trim();
        }
      }
    }
  }

  // Advanced recurring: "every year" with date (e.g., "5 may every year", "every year on may 5")
  if (/\bevery\s*year\b/i.test(title) || /\byearly\b/i.test(title) || /\bannually\b/i.test(title)) {
    repeat = 'yearly';
    repeatFlag = REPEAT_RULES['yearly'];
    // Remove these keywords from title
    title = title.replace(/\bevery\s*year\b/i, '').replace(/\byearly\b/i, '').replace(/\bannually\b/i, '').trim();
  }

  // Parse date/time using chrono-node
  const chronoParsed = chrono.parse(title, new Date(), { forwardDate: true });

  if (chronoParsed.length > 0) {
    const result = chronoParsed[0];
    dueDate = result.start.date();
    dueDateStr = result.text;

    // Check if time was specified
    hasTime = result.start.isCertain('hour') ||
              result.start.isCertain('minute') ||
              result.text.match(/\b(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm|AM|PM)?\b/) !== null ||
              result.text.match(/\b(noon|midnight|morning|afternoon|evening)\b/i) !== null;

    // Remove date text from title
    title = title.replace(result.text, '').trim();
  }

  // Also support legacy $date format for backwards compatibility
  const legacyDateMatch = title.match(/\$(\S+)/);
  if (legacyDateMatch && !dueDate) {
    dueDateStr = legacyDateMatch[1];
    dueDate = parseLegacyDate(dueDateStr);
    title = title.replace(/\$\S+/g, '').trim();
  }

  // Clean up extra spaces and punctuation
  title = title
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—]\s*/, '') // Remove leading dashes
    .replace(/\s*[-–—]\s*$/, '') // Remove trailing dashes
    .replace(/\s*at\s*$/i, '')   // Remove trailing "at" (from "meeting at 3pm" → "meeting at" → "meeting")
    .trim();

  // For recurring tasks without a date, set dueDate to next occurrence
  // TickTick requires dueDate for repeatFlag to work
  if (repeatFlag && !dueDate) {
    dueDate = getNextOccurrence(repeatFlag);
    dueDateStr = 'auto (next occurrence)';
  }

  return {
    title,
    tags,  // Array of tags: ['siemens', 'meeting', 'call']
    dueDate: dueDate ? formatDateForTickTick(dueDate, hasTime) : null,
    dueDateRaw: dueDateStr,
    hasTime,
    isAllDay: !hasTime,
    priority,
    priorityRaw: priorityStr,
    repeat,
    repeatFlag,
    isRecurring: !!repeatFlag
  };
}

/**
 * Parse legacy $date format (backwards compatibility)
 */
function parseLegacyDate(dateStr) {
  const lower = dateStr.toLowerCase();
  const now = new Date();

  if (lower === 'today') return now;
  if (lower === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  // $3d, $5d (X days from now)
  const daysMatch = lower.match(/^(\d+)d$/);
  if (daysMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(daysMatch[1]));
    return d;
  }

  // $1w, $2w (X weeks from now)
  const weeksMatch = lower.match(/^(\d+)w$/);
  if (weeksMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(weeksMatch[1]) * 7);
    return d;
  }

  // Day names
  const DAYS = { 'sunday': 0, 'sun': 0, 'monday': 1, 'mon': 1, 'tuesday': 2, 'tue': 2,
    'wednesday': 3, 'wed': 3, 'thursday': 4, 'thu': 4, 'friday': 5, 'fri': 5, 'saturday': 6, 'sat': 6 };
  if (DAYS[lower] !== undefined) {
    const targetDay = DAYS[lower];
    const d = new Date(now);
    let daysUntil = targetDay - d.getDay();
    if (daysUntil <= 0) daysUntil += 7;
    d.setDate(d.getDate() + daysUntil);
    return d;
  }

  // Month-day formats
  const MONTHS = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };

  const monthDayMatch = lower.match(/^([a-z]+)-(\d+)$/);
  if (monthDayMatch && MONTHS[monthDayMatch[1]] !== undefined) {
    const d = new Date(now.getFullYear(), MONTHS[monthDayMatch[1]], parseInt(monthDayMatch[2]));
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  return null;
}

/**
 * Format task for display
 */
export function formatParsed(parsed) {
  let parts = [`"${parsed.title}"`];
  if (parsed.tags?.length) parts.push(`🏷️${parsed.tags.join(', ')}`);
  if (parsed.dueDateRaw) {
    const timeIcon = parsed.hasTime ? '⏰' : '📅';
    parts.push(`${timeIcon}${parsed.dueDateRaw}`);
  }
  if (parsed.priority) parts.push(`⚡${parsed.priorityRaw}`);
  if (parsed.repeat) parts.push(`🔁${parsed.repeat}`);
  return parts.join(' ');
}

export default { parseTask, formatParsed, REPEAT_RULES };
