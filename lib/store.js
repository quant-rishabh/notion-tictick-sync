/**
 * In-Memory Store for Notion ↔ TickTick Sync
 * 
 * This is a simple in-memory store for quick prototyping.
 * Later, swap this with Supabase by changing the imports.
 * 
 * Data persists to JSON file during development.
 */

import fs from 'fs';
import path from 'path';

// File path for persistence (development only)
const DATA_FILE = path.join(process.cwd(), 'sync-data.json');

// In-memory data store
let store = {
  task_mappings: [],
  tracked_pages: [],
  sync_state: {
    last_notion_webhook_at: null,
    last_ticktick_poll_at: null,
    last_successful_sync_at: null
  }
};

// Load data from file on startup (if exists)
function loadFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      store = JSON.parse(data);
      console.log('📂 Loaded sync data from file');
    }
  } catch (error) {
    console.log('📂 No existing data file, starting fresh');
  }
}

// Save data to file (for persistence during dev)
function saveToFile() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error('Failed to save data:', error);
  }
}

// Initialize on module load
loadFromFile();

// ============================================
// TASK MAPPINGS
// ============================================

/**
 * Add a new task mapping
 */
export function addTaskMapping(mapping) {
  const newMapping = {
    id: generateId(),
    ...mapping,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString()
  };
  
  store.task_mappings.push(newMapping);
  saveToFile();
  
  console.log('✅ Added mapping:', newMapping.title);
  return newMapping;
}

/**
 * Find mapping by Notion block ID
 */
export function findMappingByNotionId(notionBlockId) {
  return store.task_mappings.find(m => m.notion_block_id === notionBlockId);
}

/**
 * Find mapping by TickTick task ID
 */
export function findMappingByTickTickId(ticktickTaskId) {
  return store.task_mappings.find(m => m.ticktick_task_id === ticktickTaskId);
}

/**
 * Find all mappings for a Notion page
 */
export function findMappingsByNotionPage(notionPageId) {
  return store.task_mappings.filter(m => m.notion_page_id === notionPageId);
}

/**
 * Update a mapping
 */
export function updateMapping(notionBlockId, updates) {
  const index = store.task_mappings.findIndex(m => m.notion_block_id === notionBlockId);
  if (index !== -1) {
    store.task_mappings[index] = {
      ...store.task_mappings[index],
      ...updates,
      updated_at: new Date().toISOString()
    };
    saveToFile();
    console.log('📝 Updated mapping:', store.task_mappings[index].title);
    return store.task_mappings[index];
  }
  return null;
}

/**
 * Delete a mapping by Notion block ID
 */
export function deleteMapping(notionBlockId) {
  const index = store.task_mappings.findIndex(m => m.notion_block_id === notionBlockId);
  if (index !== -1) {
    const deleted = store.task_mappings.splice(index, 1)[0];
    saveToFile();
    console.log('🗑️ Deleted mapping:', deleted.title);
    return deleted;
  }
  return null;
}

/**
 * Delete all mappings for a Notion page
 */
export function deleteMappingsByNotionPage(notionPageId) {
  const toDelete = store.task_mappings.filter(m => m.notion_page_id === notionPageId);
  store.task_mappings = store.task_mappings.filter(m => m.notion_page_id !== notionPageId);
  saveToFile();
  console.log(`🗑️ Deleted ${toDelete.length} mappings for page ${notionPageId}`);
  return toDelete;
}

/**
 * Get all mappings
 */
export function getAllMappings() {
  return store.task_mappings;
}

/**
 * Get all incomplete mappings (for reverse sync)
 */
export function getIncompleteMappings() {
  return store.task_mappings.filter(m => !m.is_completed && m.source === 'notion');
}

// ============================================
// TRACKED PAGES
// ============================================

/**
 * Add a tracked page
 */
export function addTrackedPage(page) {
  // Check if already exists
  const existing = store.tracked_pages.find(p => p.notion_page_id === page.notion_page_id);
  if (existing) {
    return existing;
  }
  
  const newPage = {
    id: generateId(),
    ...page,
    is_active: true,
    created_at: new Date().toISOString()
  };
  
  store.tracked_pages.push(newPage);
  saveToFile();
  
  console.log('📌 Added tracked page:', newPage.page_title);
  return newPage;
}

/**
 * Check if a page is tracked
 */
export function isPageTracked(notionPageId) {
  const page = store.tracked_pages.find(p => p.notion_page_id === notionPageId);
  return page?.is_active || false;
}

/**
 * Get tracked page
 */
export function getTrackedPage(notionPageId) {
  return store.tracked_pages.find(p => p.notion_page_id === notionPageId);
}

/**
 * Get all tracked pages
 */
export function getAllTrackedPages() {
  return store.tracked_pages.filter(p => p.is_active);
}

/**
 * Remove tracked page
 */
export function removeTrackedPage(notionPageId) {
  const index = store.tracked_pages.findIndex(p => p.notion_page_id === notionPageId);
  if (index !== -1) {
    store.tracked_pages[index].is_active = false;
    saveToFile();
    return store.tracked_pages[index];
  }
  return null;
}

// ============================================
// SYNC STATE
// ============================================

/**
 * Update sync state
 */
export function updateSyncState(updates) {
  store.sync_state = {
    ...store.sync_state,
    ...updates
  };
  saveToFile();
  return store.sync_state;
}

/**
 * Get sync state
 */
export function getSyncState() {
  return store.sync_state;
}

// ============================================
// UTILITIES
// ============================================

/**
 * Generate a simple unique ID
 */
function generateId() {
  return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Clear all data (for testing)
 */
export function clearAllData() {
  store = {
    task_mappings: [],
    tracked_pages: [],
    sync_state: {
      last_notion_webhook_at: null,
      last_ticktick_poll_at: null,
      last_successful_sync_at: null
    }
  };
  saveToFile();
  console.log('🧹 Cleared all sync data');
}

/**
 * Get store stats
 */
export function getStats() {
  return {
    total_mappings: store.task_mappings.length,
    completed_tasks: store.task_mappings.filter(m => m.is_completed).length,
    pending_tasks: store.task_mappings.filter(m => !m.is_completed).length,
    tracked_pages: store.tracked_pages.filter(p => p.is_active).length,
    last_sync: store.sync_state.last_successful_sync_at
  };
}

/**
 * Export store for debugging
 */
export function exportStore() {
  return store;
}
