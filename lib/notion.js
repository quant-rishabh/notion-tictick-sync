/**
 * Notion API Client
 *
 * Simple wrapper for Notion API calls
 */

// Load token from environment or use directly for testing
const NOTION_TOKEN = process.env.NOTION_TOKEN || 'ntn_c50634995881dMDO3Fd7fpfNT5Hf1gBmJwHefC1EWsi08I';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Make a request to Notion API
 */
async function notionRequest(endpoint, options = {}) {
  const url = `${NOTION_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Notion API Error:', data);
    throw new Error(data.message || 'Notion API request failed');
  }

  return data;
}

/**
 * Get a page by ID
 */
export async function getPage(pageId) {
  return notionRequest(`/pages/${pageId}`);
}

/**
 * Get all blocks (children) of a page or block
 */
export async function getBlocks(blockId, startCursor = null) {
  let endpoint = `/blocks/${blockId}/children?page_size=100`;
  if (startCursor) {
    endpoint += `&start_cursor=${startCursor}`;
  }
  return notionRequest(endpoint);
}

/**
 * Get ALL blocks recursively (handles pagination)
 */
export async function getAllBlocks(blockId) {
  let allBlocks = [];
  let hasMore = true;
  let startCursor = null;

  while (hasMore) {
    const response = await getBlocks(blockId, startCursor);
    allBlocks = allBlocks.concat(response.results);
    hasMore = response.has_more;
    startCursor = response.next_cursor;
  }

  return allBlocks;
}

/**
 * Get a single block by ID
 */
export async function getBlock(blockId) {
  return notionRequest(`/blocks/${blockId}`);
}

/**
 * Update a block (e.g., check/uncheck a to_do)
 */
export async function updateBlock(blockId, updates) {
  return notionRequest(`/blocks/${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  });
}

/**
 * Mark a to_do block as complete/incomplete
 */
export async function setTodoChecked(blockId, checked) {
  return updateBlock(blockId, {
    to_do: {
      checked: checked
    }
  });
}

/**
 * Search for pages (useful for finding pages with #track)
 */
export async function searchPages(query = '') {
  return notionRequest('/search', {
    method: 'POST',
    body: JSON.stringify({
      query: query,
      filter: {
        property: 'object',
        value: 'page'
      },
      sort: {
        direction: 'descending',
        timestamp: 'last_edited_time'
      }
    })
  });
}

/**
 * Extract plain text from rich text array
 */
export function extractPlainText(richTextArray) {
  if (!richTextArray || !Array.isArray(richTextArray)) {
    return '';
  }
  return richTextArray.map(rt => rt.plain_text || '').join('');
}

/**
 * Find all to_do blocks in a list of blocks
 */
export function findTodoBlocks(blocks) {
  return blocks.filter(block => block.type === 'to_do');
}

/**
 * Recursively fetch all to_do blocks (including nested children)
 * Returns a flat array of all to-dos at any depth (up to 5 levels)
 */
export async function getAllTodosFlat(blockId, maxDepth = 5) {
  const allTodos = [];
  
  async function fetchTodosRecursive(parentId, currentDepth) {
    if (currentDepth > maxDepth) return;
    
    const blocks = await getAllBlocks(parentId);
    const todos = findTodoBlocks(blocks);
    
    // Add todos at this level
    for (const todo of todos) {
      allTodos.push(todo);
      
      // If this todo has children, fetch nested todos too
      if (todo.has_children) {
        await fetchTodosRecursive(todo.id, currentDepth + 1);
      }
    }
  }
  
  await fetchTodosRecursive(blockId, 1);
  return allTodos;
}

/**
 * Parse a to_do block into a simple task object
 */
export function parseTodoBlock(block) {
  if (block.type !== 'to_do') {
    return null;
  }

  const todo = block.to_do;
  const text = extractPlainText(todo.rich_text);

  // Check for markers like #track, #repeat:daily, etc.
  const markers = {
    isTracked: text.includes('#track'),
    isNoTrack: text.includes('#notrack'),
    repeatPattern: null
  };

  // Extract repeat pattern if exists
  const repeatMatch = text.match(/#repeat:(\S+)/);
  if (repeatMatch) {
    markers.repeatPattern = repeatMatch[1];
  }

  // Clean title (remove markers)
  const cleanTitle = text
    .replace(/#track/g, '')
    .replace(/#notrack/g, '')
    .replace(/#repeat:\S+/g, '')
    .trim();

  return {
    block_id: block.id,
    title: cleanTitle,
    original_text: text,
    is_checked: todo.checked,
    has_children: block.has_children,
    markers: markers,
    created_time: block.created_time,
    last_edited_time: block.last_edited_time
  };
}

/**
 * Get page title from page object
 */
export function getPageTitle(page) {
  // Try different title locations
  if (page.properties) {
    // Database page
    const titleProp = Object.values(page.properties).find(p => p.type === 'title');
    if (titleProp && titleProp.title) {
      return extractPlainText(titleProp.title);
    }
  }

  // Regular page - title is in properties.title
  if (page.properties && page.properties.title && page.properties.title.title) {
    return extractPlainText(page.properties.title.title);
  }

  return 'Untitled';
}

export default {
  getPage,
  getBlocks,
  getAllBlocks,
  getAllTodosFlat,
  getBlock,
  updateBlock,
  setTodoChecked,
  searchPages,
  extractPlainText,
  findTodoBlocks,
  parseTodoBlock,
  getPageTitle
};
