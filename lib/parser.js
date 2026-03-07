/**
 * Smart Natural Language Task Parser v2
 * 
 * Supports:
 * - One-time dates (chrono-node)
 * - Recurring patterns (custom + rrule)
 * - Informal/shorthand inputs
 * - Duration support
 * - Abbreviations (hrs, min, etc.)
 */

import * as chrono from 'chrono-node';
import pkg from 'rrule';
const { RRule } = pkg;

// ==================== CONSTANTS ====================

const DAY_MAP = {
  'sunday': RRule.SU, 'sun': RRule.SU, 'su': RRule.SU,
  'monday': RRule.MO, 'mon': RRule.MO, 'mo': RRule.MO,
  'tuesday': RRule.TU, 'tue': RRule.TU, 'tu': RRule.TU, 'tues': RRule.TU,
  'wednesday': RRule.WE, 'wed': RRule.WE, 'we': RRule.WE, 'weds': RRule.WE,
  'thursday': RRule.TH, 'thu': RRule.TH, 'th': RRule.TH, 'thur': RRule.TH, 'thurs': RRule.TH,
  'friday': RRule.FR, 'fri': RRule.FR, 'fr': RRule.FR,
  'saturday': RRule.SA, 'sat': RRule.SA, 'sa': RRule.SA,
};

const DAY_NUM_MAP = {
  'SU': 0, 'MO': 1, 'TU': 2, 'WE': 3, 'TH': 4, 'FR': 5, 'SA': 6
};

const MONTH_MAP = {
  'january': 1, 'jan': 1, 'february': 2, 'feb': 2, 'march': 3, 'mar': 3,
  'april': 4, 'apr': 4, 'may': 5, 'june': 6, 'jun': 6,
  'july': 7, 'jul': 7, 'august': 8, 'aug': 8, 'september': 9, 'sep': 9, 'sept': 9,
  'october': 10, 'oct': 10, 'november': 11, 'nov': 11, 'december': 12, 'dec': 12,
};

const PRIORITY_MAP = {
  '1': 5, '!1': 5, 'high': 5, 'h': 5,
  '2': 3, '!2': 3, 'medium': 3, 'med': 3, 'm': 3,
  '3': 1, '!3': 1, 'low': 1, 'l': 1,
};

const TIME_OF_DAY = {
  'morning': { hour: 9, minute: 0 },
  'afternoon': { hour: 14, minute: 0 },
  'evening': { hour: 18, minute: 0 },
  'night': { hour: 21, minute: 0 },
  'noon': { hour: 12, minute: 0 },
  'midnight': { hour: 0, minute: 0 },
};

// ==================== PREPROCESSOR ====================

/**
 * Normalize text - expand abbreviations and fix common patterns
 */
function preprocessText(text) {
  let normalized = text.trim();
  
  // Expand time abbreviations
  normalized = normalized.replace(/\b(\d+)\s*hrs?\b/gi, '$1 hours');
  normalized = normalized.replace(/\b(\d+)\s*mins?\b/gi, '$1 minutes');
  normalized = normalized.replace(/\b(\d+)\s*secs?\b/gi, '$1 seconds');
  
  // Expand common abbreviations
  normalized = normalized.replace(/\bbday\b/gi, 'birthday');
  normalized = normalized.replace(/\bappt\b/gi, 'appointment');
  normalized = normalized.replace(/\bmtg\b/gi, 'meeting');
  normalized = normalized.replace(/\byr\b/gi, 'year');
  normalized = normalized.replace(/\bwk\b/gi, 'week');
  
  // Normalize "every other/second/alternate"
  normalized = normalized.replace(/every\s+(other|second|alternate)\s+day/gi, 'every 2 days');
  normalized = normalized.replace(/every\s+(other|second|alternate)\s+week/gi, 'every 2 weeks');
  
  // Handle shorthand day patterns without "every"
  // "gym mon wed fri" → "gym every mon wed fri"
  const dayPattern = /\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/gi;
  const dayMatches = normalized.match(dayPattern);
  if (dayMatches && dayMatches.length >= 2 && !/\bevery\b/i.test(normalized)) {
    // Multiple days mentioned without "every" - likely recurring
    const firstDayMatch = normalized.match(dayPattern);
    if (firstDayMatch) {
      const idx = normalized.toLowerCase().indexOf(firstDayMatch[0].toLowerCase());
      normalized = normalized.slice(0, idx) + 'every ' + normalized.slice(idx);
    }
  }
  
  // "weekly" at end → "every week"
  if (/\bweekly\s*$/i.test(normalized) && !/every/i.test(normalized)) {
    normalized = normalized.replace(/\bweekly\s*$/i, 'every week');
  }
  
  // "daily" without context → "every day"  
  if (/\bdaily\b/i.test(normalized) && !/every/i.test(normalized)) {
    normalized = normalized.replace(/\bdaily\b/gi, 'every day');
  }
  
  // "yearly" at end → "every year"
  if (/\byearly\s*$/i.test(normalized)) {
    normalized = normalized.replace(/\byearly\s*$/i, 'every year');
  }
  
  return normalized;
}

// ==================== MAIN PARSER ====================

function parseTask(text) {
  // Preprocess to normalize input
  let cleanedText = preprocessText(text);
  
  const result = {
    title: '',
    tags: [],
    dueDate: null,
    startDate: null,
    hasTime: false,
    isAllDay: true,
    priority: 0,
    repeatFlag: null,
    isRecurring: false,
    duration: null,
  };

  // 1. Extract #tags
  const tagMatches = cleanedText.match(/#(\w+)/g);
  if (tagMatches) {
    result.tags = tagMatches.map(t => t.slice(1));
    cleanedText = cleanedText.replace(/#\w+/g, '').trim();
  }

  // 2. Extract !priority
  const priorityMatch = cleanedText.match(/!([1-3]|high|med|medium|low)/i);
  if (priorityMatch) {
    result.priority = PRIORITY_MAP[priorityMatch[1].toLowerCase()] || 0;
    cleanedText = cleanedText.replace(/![1-3]|!(?:high|med|medium|low)/gi, '').trim();
  }

  // 3. Check for urgency keywords
  if (/\b(urgent|asap|critical|important)\b/i.test(cleanedText)) {
    if (result.priority === 0) result.priority = 5;
    cleanedText = cleanedText.replace(/\b(urgent|asap|critical|important)\b/gi, '').trim();
  }

  // 4. Extract duration FIRST (for X hours/minutes) - only small durations
  const durationMatch = cleanedText.match(/\bfor\s+(\d+)\s*(hours?|minutes?)\b/i);
  if (durationMatch) {
    const num = parseInt(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    // Only treat as duration if <= 8 hours (likely meeting duration)
    if ((unit.startsWith('h') && num <= 8) || (unit.startsWith('m') && num <= 120)) {
      if (unit.startsWith('h')) {
        result.duration = num * 60;
      } else {
        result.duration = num;
      }
      cleanedText = cleanedText.replace(durationMatch[0], '').trim();
    }
  }

  // 5. Parse recurring patterns
  const recurringResult = parseRecurring(cleanedText);
  if (recurringResult.repeatFlag) {
    result.repeatFlag = recurringResult.repeatFlag;
    result.isRecurring = true;
    cleanedText = recurringResult.cleanedText;
    
    if (recurringResult.startDate) {
      result.dueDate = recurringResult.startDate;
      result.hasTime = recurringResult.hasTime || false;
      result.isAllDay = !result.hasTime;
    }
  }

  // 6. Parse one-time date/time with chrono-node
  if (!result.dueDate) {
    const chronoResult = chrono.parse(cleanedText, new Date(), { forwardDate: true });
    if (chronoResult.length > 0) {
      const parsed = chronoResult[0];
      result.dueDate = parsed.start.date();
      result.hasTime = parsed.start.isCertain('hour');
      result.isAllDay = !result.hasTime;
      cleanedText = cleanedText.replace(parsed.text, '').trim();
    }
  }

  // 7. Handle time of day words
  for (const [word, time] of Object.entries(TIME_OF_DAY)) {
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(cleanedText)) {
      if (result.dueDate) {
        result.dueDate.setHours(time.hour, time.minute, 0, 0);
        result.hasTime = true;
        result.isAllDay = false;
      }
      cleanedText = cleanedText.replace(regex, '').trim();
    }
  }

  // 8. Calculate startDate/dueDate if duration is set
  if (result.duration && result.dueDate instanceof Date) {
    result.startDate = formatDateForTickTick(result.dueDate, result.hasTime);
    const endDate = new Date(result.dueDate.getTime() + result.duration * 60000);
    result.dueDate = formatDateForTickTick(endDate, result.hasTime);
  } else if (result.dueDate instanceof Date) {
    result.dueDate = formatDateForTickTick(result.dueDate, result.hasTime);
  }

  // 9. Clean up title
  result.title = cleanedText
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—,]\s*/, '')
    .replace(/\s*[-–—,]\s*$/, '')
    .replace(/\s+at\s*$/i, '')
    .replace(/\s+on\s*$/i, '')
    .replace(/\s+every\s*$/i, '')
    .replace(/\s+for\s*$/i, '')
    .replace(/\bfor\s+next\b/gi, '')
    .replace(/\bduring\s+the\s+day\b/gi, '')
    .trim();

  return result;
}

// ==================== RECURRING PARSER ====================

function parseRecurring(text) {
  let cleanedText = text;
  let repeatFlag = null;
  let startDate = null;
  let hasTime = false;

  // ===== INTERVAL PATTERNS (every X hours/days) =====
  const intervalMatch = cleanedText.match(/every\s+(\d+)\s+(hours?|days?|weeks?|months?)/i);
  if (intervalMatch) {
    const interval = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    
    const freqMap = {
      'hour': RRule.HOURLY, 'hours': RRule.HOURLY,
      'day': RRule.DAILY, 'days': RRule.DAILY,
      'week': RRule.WEEKLY, 'weeks': RRule.WEEKLY,
      'month': RRule.MONTHLY, 'months': RRule.MONTHLY,
    };
    
    const rule = new RRule({
      freq: freqMap[unit],
      interval: interval,
    });
    repeatFlag = rule.toString();
    
    const now = new Date();
    startDate = new Date(now);
    if (unit.startsWith('hour')) {
      startDate.setMinutes(0, 0, 0);
      startDate.setHours(startDate.getHours() + interval);
      hasTime = true;
    } else {
      startDate.setDate(startDate.getDate() + 1);
      startDate.setHours(9, 0, 0, 0);
    }
    
    cleanedText = cleanedText.replace(intervalMatch[0], '').trim();
  }

  // ===== YEARLY PATTERNS =====
  if (!repeatFlag) {
    const yearlyPatterns = [
      /(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+every\s*year/i,
      /every\s*year\s+(?:on\s+)?(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i,
      /(?:on\s+)?(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+every\s*year/i,
      /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\s+every\s*year/i,
    ];

    for (const pattern of yearlyPatterns) {
      const match = cleanedText.match(pattern);
      if (match) {
        let day, monthStr;
        if (match[1].match(/^\d+$/)) {
          day = parseInt(match[1]);
          monthStr = match[2].toLowerCase();
        } else {
          monthStr = match[1].toLowerCase();
          day = parseInt(match[2]);
        }
        
        const month = MONTH_MAP[monthStr.slice(0, 3)] || MONTH_MAP[monthStr];
        if (month && day) {
          const rule = new RRule({
            freq: RRule.YEARLY,
            bymonth: month,
            bymonthday: day,
          });
          repeatFlag = rule.toString();
          
          const now = new Date();
          startDate = new Date(now.getFullYear(), month - 1, day);
          if (startDate <= now) {
            startDate.setFullYear(startDate.getFullYear() + 1);
          }
          
          cleanedText = cleanedText.replace(match[0], '').trim();
          break;
        }
      }
    }
  }

  // ===== MONTHLY PATTERNS =====
  if (!repeatFlag) {
    const monthlyPatterns = [
      /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?every\s+month/i,
      /every\s+month\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?/i,
      /monthly\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?/i,
      /(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+monthly/i,
    ];

    for (const pattern of monthlyPatterns) {
      const match = cleanedText.match(pattern);
      if (match) {
        const day = parseInt(match[1]);
        const rule = new RRule({
          freq: RRule.MONTHLY,
          bymonthday: day,
        });
        repeatFlag = rule.toString();
        
        const now = new Date();
        startDate = new Date(now.getFullYear(), now.getMonth(), day);
        if (startDate <= now) {
          startDate.setMonth(startDate.getMonth() + 1);
        }
        
        cleanedText = cleanedText.replace(match[0], '').trim();
        break;
      }
    }
  }

  // ===== WEEKLY WITH SPECIFIC DAYS =====
  if (!repeatFlag) {
    const weeklyMatch = cleanedText.match(/every\s+((?:(?:and\s+)?(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)[\s,&]*)+)/i);
    if (weeklyMatch) {
      const daysStr = weeklyMatch[1].toLowerCase();
      const days = [];
      
      for (const [dayName, dayConst] of Object.entries(DAY_MAP)) {
        const dayRegex = new RegExp(`\\b${dayName}\\b`, 'i');
        if (dayRegex.test(daysStr)) {
          if (!days.some(d => d.weekday === dayConst.weekday)) {
            days.push(dayConst);
          }
        }
      }
      
      if (days.length > 0) {
        const rule = new RRule({
          freq: RRule.WEEKLY,
          byweekday: days,
        });
        repeatFlag = rule.toString();
        startDate = getNextWeekday(days);
        cleanedText = cleanedText.replace(weeklyMatch[0], '').trim();
      }
    }
  }

  // ===== SIMPLE RECURRING =====
  if (!repeatFlag) {
    const simplePatterns = [
      { pattern: /\bevery\s*day\b/i, freq: RRule.DAILY },
      { pattern: /\bevery\s+week\b/i, freq: RRule.WEEKLY },
      { pattern: /\bevery\s+month\b/i, freq: RRule.MONTHLY },
      { pattern: /\bevery\s*year\b/i, freq: RRule.YEARLY },
      { pattern: /\bevery\s+weekday\b/i, freq: RRule.WEEKLY, byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR] },
    ];

    for (const { pattern, freq, byweekday } of simplePatterns) {
      if (pattern.test(cleanedText)) {
        const ruleOptions = { freq };
        if (byweekday) ruleOptions.byweekday = byweekday;
        
        const rule = new RRule(ruleOptions);
        repeatFlag = rule.toString();
        
        const now = new Date();
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() + 1);
        startDate.setHours(9, 0, 0, 0);
        
        cleanedText = cleanedText.replace(pattern, '').trim();
        break;
      }
    }
  }

  // ===== END DATE / COUNT =====
  if (repeatFlag) {
    // Until pattern
    const untilPatterns = [
      /until\s+(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i,
      /until\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})/i,
    ];
    
    for (const pattern of untilPatterns) {
      const match = cleanedText.match(pattern);
      if (match) {
        let day, monthStr;
        if (match[1].match(/^\d+$/)) {
          day = parseInt(match[1]);
          monthStr = match[2];
        } else {
          monthStr = match[1];
          day = parseInt(match[2]);
        }
        
        const month = MONTH_MAP[monthStr.toLowerCase().slice(0, 3)];
        if (month && day) {
          const now = new Date();
          let untilDate = new Date(now.getFullYear(), month - 1, day, 23, 59, 59);
          if (untilDate <= now) {
            untilDate.setFullYear(untilDate.getFullYear() + 1);
          }
          
          const untilStr = untilDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
          repeatFlag = repeatFlag.replace(/\n/g, '') + `;UNTIL=${untilStr}`;
          cleanedText = cleanedText.replace(match[0], '').trim();
        }
        break;
      }
    }

    // For X days/weeks/months pattern
    const forMatch = cleanedText.match(/\bfor\s+(?:next\s+)?(\d+)\s+(days?|weeks?|months?)\b/i);
    if (forMatch) {
      const num = parseInt(forMatch[1]);
      const unit = forMatch[2].toLowerCase();
      
      let countValue = num;
      if (repeatFlag.includes('FREQ=DAILY')) {
        if (unit.startsWith('week')) countValue = num * 7;
        else if (unit.startsWith('month')) countValue = num * 30;
      } else if (repeatFlag.includes('FREQ=WEEKLY')) {
        if (unit.startsWith('month')) countValue = num * 4;
      }
      
      repeatFlag = repeatFlag.replace(/\n/g, '') + `;COUNT=${countValue}`;
      cleanedText = cleanedText.replace(forMatch[0], '').trim();
    }
  }

  // ===== PARSE TIME =====
  if (repeatFlag) {
    const timePatterns = [
      /(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)/i,
      /(?:at\s+)?(\d{1,2})\s*(am|pm)/i,
      /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i,
    ];
    
    for (const pattern of timePatterns) {
      const match = cleanedText.match(pattern);
      if (match) {
        let hours = parseInt(match[1]);
        const minutes = match[2] && !isNaN(parseInt(match[2])) ? parseInt(match[2]) : 0;
        const ampm = (match[3] || '').toLowerCase();
        
        if (ampm === 'pm' && hours < 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
        
        if (startDate) {
          startDate.setHours(hours, minutes, 0, 0);
          hasTime = true;
        }
        
        cleanedText = cleanedText.replace(match[0], '').trim();
        break;
      }
    }
  }

  return { repeatFlag, cleanedText, startDate, hasTime };
}

// ==================== HELPERS ====================

function getNextWeekday(days) {
  const now = new Date();
  const currentDay = now.getDay();
  
  const dayNums = days.map(d => {
    if (typeof d === 'object' && d.weekday !== undefined) {
      return d.weekday;
    }
    return DAY_NUM_MAP[d.toString().slice(-2)] ?? d;
  });
  
  let minDays = 7;
  for (const target of dayNums) {
    let diff = target - currentDay;
    if (diff <= 0) diff += 7;
    if (diff < minDays) minDays = diff;
  }
  
  const next = new Date(now);
  next.setDate(next.getDate() + minDays);
  next.setHours(9, 0, 0, 0);
  return next;
}

function formatDateForTickTick(date, hasTime = false) {
  if (!date) return null;
  if (typeof date === 'string') return date;
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = '00';
  
  const tzOffset = -date.getTimezoneOffset();
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${tzSign}${tzHours}${tzMinutes}`;
}

export { parseTask };
