/**
 * Cron Job: Reverse Sync Only (TickTick -> Notion)
 *
 * ONLY handles: TickTick completions -> Notion checkboxes
 * Forward sync (Notion -> TickTick) is handled by WEBHOOKS!
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const TICKTICK_COOKIE_TOKEN = process.env.TICKTICK_COOKIE_TOKEN;

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_SYNC_TAG = 'notion-sync';

// ==================== NOTION API ====================

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
  return response.json();
}

async function setTodoChecked(blockId, checked) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ to_do: { checked } })
  });
}

async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

// ==================== TICKTICK API ====================

// Remove notion-sync tag from task after successful sync
async function removeNotionSyncTag(task) {
  try {
    const newTags = (task.tags || []).filter(t => t !== NOTION_SYNC_TAG);
    
    const res = await fetch(`https://api.ticktick.com/api/v2/task/${task.id}`, {
      method: 'POST',
      headers: {
        'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        id: task.id,
        projectId: task.projectId,
        tags: newTags
      })
    });

    if (res.ok) {
      console.log(`   Tag removed from: "${task.title}"`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`   Failed to remove tag: ${e.message}`);
    return false;
  }
}

async function getCompletedNotionTasks() {
  if (!TICKTICK_COOKIE_TOKEN) {
    console.log('No cookie token, skipping reverse sync');
    return [];
  }

  try {
    // Use tag-based completed task API - ONE call instead of per-project!
    const allTasks = [];
    let nextToken = '';

    do {
      const res = await fetch('https://api.ticktick.com/api/v2/tag/completedTask', {
        method: 'POST',
        headers: {
          'Cookie': `t=${TICKTICK_COOKIE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tags: [NOTION_SYNC_TAG],
          token: nextToken,
          limit: 50
        })
      });

      if (!res.ok) {
        console.log('Cookie expired or API error');
        return [];
      }

      const data = await res.json();
      if (data.tasks && Array.isArray(data.tasks)) {
        allTasks.push(...data.tasks);
      }
      nextToken = data.nextToken || '';
    } while (nextToken);

    console.log(`Found ${allTasks.length} completed tasks with notion-sync tag`);
    return allTasks;
  } catch (e) {
    console.error('Error:', e.message);
    return [];
  }
}

// ==================== MAIN HANDLER ====================

export default async function handler(req, res) {
  console.log('Running reverse sync (TickTick -> Notion)...');

  if (!NOTION_TOKEN || !TICKTICK_COOKIE_TOKEN) {
    return res.status(500).json({
      error: 'Missing environment variables',
      required: ['NOTION_TOKEN', 'TICKTICK_COOKIE_TOKEN']
    });
  }

  const stats = { checked: 0, skipped: 0, errors: 0, tagsRemoved: 0 };

  try {
    const completedTasks = await getCompletedNotionTasks();

    for (const task of completedTasks) {
      const match = task.content ? task.content.match(/notion:([a-f0-9-]+)/) : null;
      if (!match) continue;

      const notionBlockId = match[1];

      if (task.repeatFlag) {
        stats.skipped++;
        continue;
      }

      try {
        const block = await getBlock(notionBlockId);

        if (block.object === 'error') {
          // Block deleted in Notion - still remove the tag to clean up
          console.log(`Block not found, cleaning up: "${task.title}"`);
          await removeNotionSyncTag(task);
          stats.tagsRemoved++;
          stats.errors++;
          continue;
        }

        if (block.to_do && !block.to_do.checked) {
          console.log(`Checking: "${task.title}"`);
          await setTodoChecked(notionBlockId, true);
          stats.checked++;
        } else {
          stats.skipped++;
        }

        // Remove tag after successful processing (whether checked or already checked)
        const tagRemoved = await removeNotionSyncTag(task);
        if (tagRemoved) stats.tagsRemoved++;
      } catch (e) {
        stats.errors++;
      }
    }

    console.log(`Done: ${stats.checked} checked, ${stats.skipped} skipped, ${stats.tagsRemoved} tags removed`);

    return res.status(200).json({
      ok: true,
      ...stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sync error:', error);
    return res.status(500).json({ error: error.message });
  }
}

export const config = {
  maxDuration: 30
};
