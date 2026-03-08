/**
 * AI-Powered Task Parser
 *
 * Uses OpenAI to understand natural language tasks
 * Then builds TickTick-compatible format
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USER_TIMEZONE_OFFSET = 330; // IST (+5:30) - hardcoded for India

// Time of day mappings (user preferences)
const TIME_OF_DAY = {
  morning: { hour: 8, minute: 0 },   // 8 AM
  mrng: { hour: 8, minute: 0 },
  noon: { hour: 13, minute: 0 },     // 1 PM
  afternoon: { hour: 13, minute: 0 },
  evening: { hour: 18, minute: 0 },  // 6 PM
  evng: { hour: 18, minute: 0 },
  night: { hour: 22, minute: 0 }     // 10 PM
};

// ==================== AI PARSER ====================

async function parseWithAI(text) {
  // Get current date info for context
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

  const prompt = `Parse this task and extract structured data.

Task: "${text}"
Today: ${today} (${dayOfWeek})
Timezone: IST (+5:30)

Return ONLY valid JSON (no markdown, no explanation):
{
  "title": "clean task title without date/time/recurring info",
  "date": "YYYY-MM-DD or null if no specific date",
  "time": "HH:MM in 24h format or null",
  "timeOfDay": "morning" | "afternoon" | "evening" | "night" | null (if vague time mentioned like 'in the morning'),
  "duration": minutes as number or null,
  "recurring": null if not recurring, OR {
    "frequency": "daily" | "weekly" | "monthly" | "yearly",
    "interval": number (1 for every, 2 for alternate/every other),
    "daysOfWeek": ["mon","tue","wed","thu","fri","sat","sun"] or null,
    "dayOfMonth": number 1-31 or null,
    "monthOfYear": number 1-12 or null,
    "endAfter": number of occurrences or null,
    "endDate": "YYYY-MM-DD" or null
  }
}

Examples:
- "buy milk tomorrow 5pm" → date: tomorrow's date, time: "17:00", recurring: null
- "gym every mon wed fri 7am" → recurring: {frequency:"weekly", daysOfWeek:["mon","wed","fri"]}, time:"07:00"
- "meeting every 2 weeks" → recurring: {frequency:"weekly", interval:2}
- "call mom day after tomorrow evening" → date: 2 days from now, timeOfDay: "evening"
- "workout in the morning" → timeOfDay: "morning", time: null
- "dinner tonight" → timeOfDay: "night", date: today
- "take medicine every 8 hours" → recurring: {frequency:"daily", interval:1}, note: hourly not supported, use daily
- "birthday 5 may every year" → recurring: {frequency:"yearly", dayOfMonth:5, monthOfYear:5}
- "rent 1st of every month" → recurring: {frequency:"monthly", dayOfMonth:1}
- "standup weekdays 10am" → recurring: {frequency:"weekly", daysOfWeek:["mon","tue","wed","thu","fri"]}, time:"10:00"`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a task parser. Return only valid JSON, no markdown code blocks.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      console.error('OpenAI API error:', response.status);
      return null;
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content?.trim();

    // Remove markdown code blocks if present
    if (content.startsWith('```')) {
      content = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('AI parsing error:', error.message);
    return null;
  }
}

// ==================== RRULE BUILDER ====================

function buildRRule(recurring) {
  if (!recurring) return null;

  const freqMap = {
    'daily': 'DAILY',
    'weekly': 'WEEKLY',
    'monthly': 'MONTHLY',
    'yearly': 'YEARLY'
  };

  const dayMap = {
    'sun': 'SU', 'mon': 'MO', 'tue': 'TU', 'wed': 'WE',
    'thu': 'TH', 'fri': 'FR', 'sat': 'SA'
  };

  let parts = [`FREQ=${freqMap[recurring.frequency]}`];

  // Interval (every 2 days, every other week, etc.)
  if (recurring.interval && recurring.interval > 1) {
    parts.push(`INTERVAL=${recurring.interval}`);
  }

  // Days of week (mon, wed, fri)
  if (recurring.daysOfWeek && recurring.daysOfWeek.length > 0) {
    const days = recurring.daysOfWeek.map(d => dayMap[d.toLowerCase()]).filter(Boolean);
    if (days.length > 0) {
      parts.push(`BYDAY=${days.join(',')}`);
    }
  }

  // Day of month (1st, 15th, etc.)
  if (recurring.dayOfMonth) {
    parts.push(`BYMONTHDAY=${recurring.dayOfMonth}`);
  }

  // Month of year (for yearly)
  if (recurring.monthOfYear) {
    parts.push(`BYMONTH=${recurring.monthOfYear}`);
  }

  // End after X occurrences
  if (recurring.endAfter) {
    parts.push(`COUNT=${recurring.endAfter}`);
  }

  // End by date
  if (recurring.endDate) {
    const until = recurring.endDate.replace(/-/g, '') + 'T235959Z';
    parts.push(`UNTIL=${until}`);
  }

  return 'RRULE:' + parts.join(';');
}

// ==================== DATE FORMATTER ====================

function formatDateForTickTick(dateStr, timeStr) {
  if (!dateStr) return null;

  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(5, 7);
  const day = dateStr.slice(8, 10);

  let hours = '09';
  let minutes = '00';

  if (timeStr) {
    hours = timeStr.slice(0, 2);
    minutes = timeStr.slice(3, 5);
  }

  // Build timezone string from offset
  const tzOffset = USER_TIMEZONE_OFFSET;
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';

  return `${year}-${month}-${day}T${hours}:${minutes}:00${tzSign}${tzHours}${tzMinutes}`;
}

function getNextOccurrence(recurring, timeStr) {
  const now = new Date();
  let nextDate = new Date(now);

  if (recurring.monthOfYear && recurring.dayOfMonth) {
    // Yearly: specific month and day (check this FIRST before dayOfMonth alone)
    nextDate = new Date(now.getFullYear(), recurring.monthOfYear - 1, recurring.dayOfMonth);
    if (nextDate <= now) {
      nextDate.setFullYear(nextDate.getFullYear() + 1);
    }
  } else if (recurring.daysOfWeek && recurring.daysOfWeek.length > 0) {
    // Find next matching day of week
    const dayMap = { 'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6 };
    const targetDays = recurring.daysOfWeek.map(d => dayMap[d.toLowerCase()]);
    const currentDay = now.getDay();

    let minDiff = 7;
    for (const target of targetDays) {
      let diff = target - currentDay;
      if (diff <= 0) diff += 7;
      if (diff < minDiff) minDiff = diff;
    }
    nextDate.setDate(nextDate.getDate() + minDiff);
  } else if (recurring.dayOfMonth) {
    // Monthly: specific day of month
    nextDate.setDate(recurring.dayOfMonth);
    if (nextDate <= now) {
      nextDate.setMonth(nextDate.getMonth() + 1);
    }
  } else {
    // Daily or simple recurring: start tomorrow
    nextDate.setDate(nextDate.getDate() + 1);
  }

  const dateStr = nextDate.toISOString().split('T')[0];
  return formatDateForTickTick(dateStr, timeStr);
}

// ==================== MAIN PARSER ====================

async function parseTask(text) {
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
    reminders: []
  };

  let cleanedText = text.trim();

  // 1. Extract #tags (regex - fast)
  const tagMatches = cleanedText.match(/#(\w+)/g);
  if (tagMatches) {
    result.tags = tagMatches.map(t => t.slice(1));
    cleanedText = cleanedText.replace(/#\w+/g, '').trim();
  }

  // 2. Extract !priority (regex - fast)
  const priorityMatch = cleanedText.match(/!([1-3]|high|med|medium|low)/i);
  if (priorityMatch) {
    const pMap = { '1': 5, 'high': 5, '2': 3, 'med': 3, 'medium': 3, '3': 1, 'low': 1 };
    result.priority = pMap[priorityMatch[1].toLowerCase()] || 0;
    cleanedText = cleanedText.replace(/![1-3]|!(?:high|med|medium|low)/gi, '').trim();
  }

  // 3. Check for urgency keywords
  if (/\b(urgent|asap|critical|important)\b/i.test(cleanedText)) {
    if (result.priority === 0) result.priority = 5;
    cleanedText = cleanedText.replace(/\b(urgent|asap|critical|important)\b/gi, '').trim();
  }

  // 4. Call AI to parse the natural language part
  const aiResult = await parseWithAI(cleanedText);

  if (aiResult) {
    result.title = aiResult.title || cleanedText;

    // Handle timeOfDay (morning/afternoon/evening/night)
    if (aiResult.timeOfDay && TIME_OF_DAY[aiResult.timeOfDay.toLowerCase()]) {
      const tod = TIME_OF_DAY[aiResult.timeOfDay.toLowerCase()];
      aiResult.time = `${String(tod.hour).padStart(2, '0')}:${String(tod.minute).padStart(2, '0')}`;
      console.log(`[AI] Converted timeOfDay "${aiResult.timeOfDay}" to time ${aiResult.time}`);
    }

    result.hasTime = !!aiResult.time;
    result.isAllDay = !aiResult.time;
    result.duration = aiResult.duration;

    if (aiResult.recurring) {
      // Recurring task
      result.isRecurring = true;
      result.repeatFlag = buildRRule(aiResult.recurring);
      result.dueDate = getNextOccurrence(aiResult.recurring, aiResult.time);
    } else if (aiResult.date) {
      // One-time task with date
      result.dueDate = formatDateForTickTick(aiResult.date, aiResult.time);
    }

    // Handle duration (startDate + dueDate)
    if (result.duration && result.dueDate) {
      result.startDate = result.dueDate;
      // Parse dueDate, add duration, format again
      const dueDateMatch = result.dueDate.match(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
      if (dueDateMatch) {
        const [, dateStr, hours, mins] = dueDateMatch;
        const startTime = parseInt(hours) * 60 + parseInt(mins);
        const endTime = startTime + result.duration;
        const endHours = String(Math.floor(endTime / 60) % 24).padStart(2, '0');
        const endMins = String(endTime % 60).padStart(2, '0');
        result.dueDate = formatDateForTickTick(dateStr, `${endHours}:${endMins}`);
      }
    }
  } else {
    // AI failed - use text as title
    result.title = cleanedText;
  }

  // Clean up title
  result.title = result.title
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—,]\s*/, '')
    .replace(/\s*[-–—,]\s*$/, '')
    .trim();

  // Generate reminders based on task type
  result.reminders = generateReminders(result, aiResult);

  return result;
}

// ==================== REMINDER GENERATOR ====================

function generateReminders(taskResult, aiResult) {
  // Rule: No date at all → skip reminder
  if (!taskResult.dueDate) {
    console.log('[REMINDER] No date → skipping reminder');
    return [];
  }

  const reminders = [];
  const now = new Date();

  // Get IST time
  const istNow = new Date(now.getTime() + (USER_TIMEZONE_OFFSET * 60 * 1000));
  const istHour = istNow.getUTCHours();
  const istMinute = istNow.getUTCMinutes();

  // Parse the due date to check if it's today
  const dueDateMatch = taskResult.dueDate.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!dueDateMatch) {
    console.log('[REMINDER] Could not parse dueDate');
    return [];
  }

  const [, year, month, day, dueHour, dueMinute] = dueDateMatch;
  const dueDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  const todayIST = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));

  const isToday = dueDate.getTime() === todayIST.getTime();

  // Check if task has specific time (not just 09:00 default)
  const hasSpecificTime = taskResult.hasTime || (aiResult && aiResult.timeOfDay);

  if (hasSpecificTime) {
    // Rule: Has specific time → 15 min before
    // TRIGGER:-PT15M means 15 minutes before due time
    reminders.push('TRIGGER:-PT15M');
    console.log(`[REMINDER] Has time ${dueHour}:${dueMinute} → 15 min before`);
  } else {
    // No specific time - check scenarios
    if (isToday) {
      // Rule: Date only, today, after 7 AM → 1 hour later
      if (istHour >= 7) {
        // Calculate 1 hour from now
        const reminderHour = istHour + 1;
        const reminderMinute = istMinute;

        // Convert to trigger format: time from start of day
        // P0D = 0 days, T{H}H{M}M{S}S = time
        const hours = reminderHour;
        const mins = reminderMinute;
        reminders.push(`TRIGGER:P0DT${hours}H${mins}M0S`);
        console.log(`[REMINDER] Today, after 7AM → 1 hour later (${hours}:${String(mins).padStart(2,'0')})`);
      } else {
        // Before 7 AM → remind at 7 AM
        reminders.push('TRIGGER:P0DT7H0M0S');
        console.log('[REMINDER] Today, before 7AM → 7 AM');
      }
    } else {
      // Rule: Date only, future date → 7 AM that day
      reminders.push('TRIGGER:P0DT7H0M0S');
      console.log('[REMINDER] Future date, no time → 7 AM');
    }
  }

  return reminders;
}

export { parseTask };
