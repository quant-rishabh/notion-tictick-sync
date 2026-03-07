/**
 * Notion Webhook Handler
 *
 * Receives real-time updates from Notion when blocks are changed.
 * More efficient than polling - syncs only the changed blocks.
 *
 * Flow:
 * 1. CREATE: Block exists in Notion, not in TickTick -> Create task
 * 2. UPDATE: Block exists in Notion, exists in TickTick -> Update task
 * 3. DELETE: Block returns 404 from Notion -> Delete from TickTick
 * 4. CHECK (one-time): Block checked:true -> COMPLETE in TickTick
 * 5. CHECK (recurring): Block checked:true -> DELETE from TickTick (stops forever)
 *
 * Uses TickTick Search API for O(1) lookup by block ID
 */

import { parseTask } from '../../lib/ai-parser.js';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_BEARER_TOKEN = process.env.TICKTICK_BEARER_TOKEN;
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN;
const TICKTICK_USER_ID = process.env.TICKTICK_USER_ID;

const NOTION_API_BASE = 'https://api.notion.com/v1';
const TICKTICK_API_BASE = 'https://api.ticktick.com/open/v1';
const NOTION_SYNC_TAG = 'notion-sync';
const NOTION_RECURRING_TAG = 'notion-recurring';

// ==================== API HELPERS ====================

async function notionRequest(endpoint, options = {}) {
  const response = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return { data: await response.json(), status: response.status };
}

async function ticktickRequest(endpoint, options = {}) {
  const response = await fetch(`${TICKTICK_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TICKTICK_BEARER_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

// ==================== TICKTICK SEARCH (Fast O(1) lookup) ====================

async function findTickTickTaskByNotionId(notionBlockId) {
  // Method 1: Try Search API (requires cookie - fastest)
  if (TICKTICK_COOKIE_TOKEN) {
    try {
      const searchUrl = `https://api.ticktick.com/api/v2/search/all?keywords=notion:${notionBlockId}`;
      const response = await fetch(searchUrl, {
        headers: {
          'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.tasks && data.tasks.length > 0) {
          console.log(`   Found via Search API`);
          return data.tasks[0];
        }
      }
    } catch (e) {
      console.log(`   Search API failed, falling back to Open API`);
    }
  }

  // Method 2: Fallback to Open API (scan all projects)
  console.log(`   Searching via Open API...`);
  const projects = await ticktickRequest('/project');
  const inboxId = `inbox${TICKTICK_USER_ID}`;
  const projectIds = [...(projects || []).map(p => p.id), inboxId];

  for (const projectId of projectIds) {
    try {
      const data = await ticktickRequest(`/project/${projectId}/data`);
      if (data && data.tasks) {
        const found = data.tasks.find(t => {
          const match = t.content ? t.content.match(/notion:([a-f0-9-]+)/) : null;
          return match && match[1] === notionBlockId;
        });
        if (found) return found;
      }
    } catch (e) {
      // Skip failed projects
    }
  }

  return null;
}

// ==================== TICKTICK OPERATIONS ====================

async function createTask(taskData) {
  const tags = taskData.tags || [];
  
  // Use different tag for recurring vs one-time tasks
  const syncTag = taskData.isRecurring ? NOTION_RECURRING_TAG : NOTION_SYNC_TAG;
  if (!tags.includes(syncTag)) {
    tags.push(syncTag);
  }

  const body = {
    title: taskData.title,
    content: taskData.content || '',
    projectId: `inbox${TICKTICK_USER_ID}`,
    tags: tags,
    priority: taskData.priority || 0,
  };

  // Add optional fields
  if (taskData.dueDate) body.dueDate = taskData.dueDate;
  if (taskData.startDate) body.startDate = taskData.startDate;
  if (taskData.repeatFlag) body.repeatFlag = taskData.repeatFlag;
  if (taskData.isAllDay !== undefined) body.isAllDay = taskData.isAllDay;

  return ticktickRequest('/task', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function updateTask(taskData) {
  return ticktickRequest(`/task/${taskData.id}`, {
    method: 'POST',
    body: JSON.stringify(taskData)
  });
}

async function deleteTask(taskId, projectId) {
  return ticktickRequest(`/project/${projectId}/task/${taskId}`, {
    method: 'DELETE'
  });
}

// Complete task in TickTick (not delete!)
async function completeTask(taskId, projectId) {
  return ticktickRequest(`/project/${projectId}/task/${taskId}/complete`, {
    method: 'POST'
  });
}

// ==================== SYNC SINGLE BLOCK ====================

function getNotionLink(pageId, blockId) {
  // Remove dashes from IDs for URL
  const cleanPageId = pageId.replace(/-/g, '');
  const cleanBlockId = blockId.replace(/-/g, '');
  return `https://notion.so/${cleanPageId}#${cleanBlockId}`;
}

async function syncBlock(blockId, pageId = '') {
  console.log(`Syncing block: ${blockId}`);

  // 1. Get block from Notion
  const { data: block, status } = await getBlock(blockId);

  // 2. Fast lookup in TickTick
  const existingTask = await findTickTickTaskByNotionId(blockId);
  console.log(`   TickTick task: ${existingTask ? existingTask.id : 'NOT FOUND'}`);

  // CASE 1: Block deleted from Notion (404)
  if (status === 404 || block.object === 'error') {
    if (existingTask) {
      console.log(`   Block deleted from Notion, removing from TickTick`);
      await deleteTask(existingTask.id, existingTask.projectId);
      return { action: 'deleted', reason: 'notion block deleted' };
    }
    return { action: 'skipped', reason: 'block not found, no task' };
  }

  // CASE 2: Not a todo block
  if (block.type !== 'to_do') {
    console.log(`   Skipping non-todo block (${block.type})`);
    return { action: 'skipped', reason: 'not a todo' };
  }

  const rawText = block.to_do.rich_text.map(r => r.plain_text).join('');
  const isChecked = block.to_do.checked;

  // CASE 3: Empty todo - delete from TickTick if exists
  if (!rawText.trim()) {
    if (existingTask) {
      console.log(`   Deleting empty task from TickTick`);
      await deleteTask(existingTask.id, existingTask.projectId);
      return { action: 'deleted', reason: 'empty todo' };
    }
    return { action: 'skipped', reason: 'empty todo, no task' };
  }

  // CASE 4: Checked todo - Handle differently for recurring vs one-time
  if (isChecked) {
    if (existingTask) {
      // Check if it's a recurring task (has notion-recurring tag)
      const isRecurring = existingTask.tags && existingTask.tags.includes(NOTION_RECURRING_TAG);
      
      if (isRecurring) {
        // RECURRING: Delete task entirely to stop all future instances
        console.log(`   ♻️ Recurring task checked in Notion, DELETING from TickTick: "${rawText}"`);
        await deleteTask(existingTask.id, existingTask.projectId);
        return { action: 'deleted', reason: 'recurring task stopped via Notion' };
      } else {
        // ONE-TIME: Just complete it
        console.log(`   ✅ Task checked in Notion, completing in TickTick: "${rawText}"`);
        await completeTask(existingTask.id, existingTask.projectId);
        return { action: 'completed', reason: 'checked in notion' };
      }
    }
    return { action: 'skipped', reason: 'checked, no task' };
  }

  // CASE 5: Unchecked todo with text -> CREATE or UPDATE
  const parsed = await parseTask(rawText);

  if (existingTask) {
    // UPDATE existing task
    const existingUserTags = (existingTask.tags || [])
      .filter(t => t !== NOTION_SYNC_TAG).sort().join(',');
    const newUserTags = (parsed.tags || []).sort().join(',');

    if (existingTask.title !== parsed.title || existingUserTags !== newUserTags) {
      console.log(`   Updating: "${parsed.title}"`);

      const updatedTags = [...(parsed.tags || [])];
      if (!updatedTags.includes(NOTION_SYNC_TAG)) {
        updatedTags.push(NOTION_SYNC_TAG);
      }

      await updateTask({
        id: existingTask.id,
        projectId: existingTask.projectId,
        title: parsed.title,
        content: existingTask.content,
        tags: updatedTags,
        priority: parsed.priority || 0
      });

      return { action: 'updated', title: parsed.title };
    }

    return { action: 'skipped', reason: 'no changes' };
  } else {
    // CREATE new task
    const taskType = parsed.isRecurring ? '🔄 recurring' : '📝 one-time';
    console.log(`   Creating ${taskType}: "${parsed.title}"`);

    // Build content with Notion link for easy navigation
    const notionLink = pageId ? getNotionLink(pageId, blockId) : '';
    const content = notionLink
      ? `notion:${blockId}\n\n📎 Open in Notion:\n${notionLink}`
      : `notion:${blockId}`;

    await createTask({
      title: parsed.title,
      content: content,
      tags: parsed.tags || [],
      priority: parsed.priority || 0,
      dueDate: parsed.dueDate,
      startDate: parsed.startDate,
      repeatFlag: parsed.repeatFlag,
      isRecurring: parsed.isRecurring,
      isAllDay: parsed.isAllDay
    });

    return { action: 'created', title: parsed.title, recurring: parsed.isRecurring };
  }
}

// ==================== MAIN WEBHOOK HANDLER ====================

export default async function handler(req, res) {
  // Handle verification challenge from Notion
  // Notion sends a verification_token in POST body that must be echoed back
  
  // GET request verification (query param)
  if (req.method === 'GET') {
    const challenge = req.query.challenge;
    if (challenge) {
      console.log('Responding to GET webhook verification challenge');
      return res.status(200).send(challenge);
    }
    return res.status(200).json({ status: 'Notion webhook endpoint ready' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // LOG EVERYTHING for debugging
  const payload = req.body;
  console.log('=== WEBHOOK RECEIVED ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(payload, null, 2));
  console.log('========================');
  
  // POST request verification (Notion sends verification_token in body)
  // Check for ANY verification-related field
  const token = payload.verification_token || payload.challenge || payload.token;
  
  if (payload.type === 'url_verification' || token) {
    console.log('🔑 VERIFICATION TOKEN RECEIVED:', token);
    // Return token in multiple formats to ensure compatibility
    return res.status(200).json({ 
      ok: true,
      challenge: token,
      verification_token: token 
    });
  }

  // Validate environment
  if (!NOTION_TOKEN || !TICKTICK_BEARER_TOKEN || !TICKTICK_USER_ID) {
    return res.status(500).json({
      error: 'Missing environment variables',
      required: ['NOTION_TOKEN', 'TICKTICK_BEARER_TOKEN', 'TICKTICK_USER_ID']
    });
  }

  console.log('Received webhook:', JSON.stringify(payload, null, 2));

  // Handle different event types
  const eventType = payload.type;

  if (eventType === 'page.content_updated') {
    const updatedBlocks = payload.data?.updated_blocks || [];
    // entity.id is the page where the task exists (correct!)
    // data.parent.id is the PARENT of that page (wrong!)
    const taskPageId = payload.entity?.id || payload.data?.parent?.id || '';
    console.log(`Processing ${updatedBlocks.length} updated blocks (page: ${taskPageId})`);

    const results = {
      processed: 0,
      created: 0,
      updated: 0,
      completed: 0,
      deleted: 0,
      skipped: 0,
      errors: []
    };

    for (const blockInfo of updatedBlocks) {
      const blockId = blockInfo.id;

      try {
        const result = await syncBlock(blockId, taskPageId);
        results.processed++;

        switch (result.action) {
          case 'created': results.created++; break;
          case 'updated': results.updated++; break;
          case 'completed': results.completed++; break;
          case 'deleted': results.deleted++; break;
          case 'skipped': results.skipped++; break;
        }
      } catch (error) {
        console.error(`Error syncing block ${blockId}:`, error.message);
        results.errors.push({ blockId, error: error.message });
      }
    }

    console.log(`Webhook processed: ${results.created} created, ${results.updated} updated, ${results.completed} completed, ${results.deleted} deleted, ${results.skipped} skipped`);

    return res.status(200).json({
      ok: true,
      event: eventType,
      ...results,
      timestamp: new Date().toISOString()
    });
  }

  // Handle page.created (new page)
  if (eventType === 'page.created') {
    console.log('New page created, will sync on next cron run');
    return res.status(200).json({ ok: true, event: eventType, message: 'Acknowledged' });
  }

  // Handle page.deleted
  if (eventType === 'page.deleted') {
    console.log('Page deleted event received');
    return res.status(200).json({ ok: true, event: eventType, message: 'Acknowledged' });
  }

  // Unknown event type - still acknowledge
  console.log(`Unknown event type: ${eventType}`);
  return res.status(200).json({ ok: true, event: eventType, message: 'Acknowledged' });
}

export const config = {
  maxDuration: 30
};
