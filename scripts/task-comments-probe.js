#!/usr/bin/env node

const API_BASE = 'https://api.ticktick.com/open/v1';

const token = process.env.TICKTICK_BEARER_TOKEN;
const projectId = process.env.TICKTICK_PROJECT_ID;
const taskId = process.env.TICKTICK_TASK_ID;
const commentId = process.env.TICKTICK_COMMENT_ID;
const commentText = process.env.TICKTICK_COMMENT_TEXT || 'Comment API probe';
const allowMutation = process.env.TICKTICK_ALLOW_MUTATION === '1';

function usage() {
    console.log(`
TickTick task comments probe

Required environment variables:
  TICKTICK_BEARER_TOKEN   TickTick Open API bearer token
  TICKTICK_PROJECT_ID     Project/list identifier
  TICKTICK_TASK_ID        Task identifier

Optional environment variables:
  TICKTICK_COMMENT_ID     Comment identifier for delete
  TICKTICK_COMMENT_TEXT   Text used by add (default: "Comment API probe")
  TICKTICK_ALLOW_MUTATION Set to 1 before add/delete/smoke

Commands:
  list       Fetch comments and print the latest comment (default)
  add        Add one comment
  delete     Delete TICKTICK_COMMENT_ID
  smoke      List, add, list, and delete the newly-created comment
  order      Add three comments, inspect API order, and delete them

Examples (PowerShell):
  $env:TICKTICK_BEARER_TOKEN = '...'
  $env:TICKTICK_PROJECT_ID = '...'
  $env:TICKTICK_TASK_ID = '...'
  node scripts/task-comments-probe.js list

  $env:TICKTICK_ALLOW_MUTATION = '1'
  $env:TICKTICK_COMMENT_TEXT = 'API smoke test'
  node scripts/task-comments-probe.js smoke
`);
}

function requireValue(name, value) {
    if (!value) {
        throw new Error(`Missing ${name}. Set it in the environment before running the probe.`);
    }
}

function commentsUrl() {
    return `${API_BASE}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/comments`;
}

function commentUrl(id) {
    const base = `${API_BASE}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/comment`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
}

async function request(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });

    const rawBody = await response.text();
    let body = rawBody;
    try {
        body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
        // Keep non-JSON API responses as text.
    }

    console.log(`${options.method || 'GET'} ${url} -> ${response.status} ${response.statusText}`);
    if (body !== null && body !== '') {
        console.log(JSON.stringify(body, null, 2));
    }

    if (!response.ok) {
        throw new Error(`TickTick API request failed with HTTP ${response.status}`);
    }

    return body;
}

function getLatestComment(comments) {
    if (!Array.isArray(comments) || comments.length === 0) return null;

    function timestampValue(value) {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
        return Date.parse(value || '') || 0;
    }

    return [...comments].sort((a, b) => {
        const aTime = timestampValue(a.modifiedTime || a.createdTime);
        const bTime = timestampValue(b.modifiedTime || b.createdTime);
        return bTime - aTime;
    })[0];
}

async function listComments() {
    const comments = await request(commentsUrl());
    const latest = getLatestComment(comments);
    console.log('\nLatest comment:');
    console.log(latest ? JSON.stringify(latest, null, 2) : '(none)');
    return comments;
}

async function addComment() {
    if (!allowMutation) {
        throw new Error('Add is blocked. Set TICKTICK_ALLOW_MUTATION=1 to explicitly enable mutations.');
    }

    return request(commentUrl(''), {
        method: 'POST',
        body: JSON.stringify({ title: commentText })
    });
}

async function deleteComment(id) {
    if (!allowMutation) {
        throw new Error('Delete is blocked. Set TICKTICK_ALLOW_MUTATION=1 to explicitly enable mutations.');
    }
    requireValue('TICKTICK_COMMENT_ID', id);
    return request(commentUrl(id), { method: 'DELETE' });
}

async function probeOrder() {
    if (!allowMutation) {
        throw new Error('Order probe is blocked. Set TICKTICK_ALLOW_MUTATION=1 to explicitly enable mutations.');
    }

    const createdIds = [];
    const probeTexts = [
        'API order probe 1',
        'API order probe 2',
        'API order probe 3'
    ];

    try {
        for (const title of probeTexts) {
            const created = await request(commentUrl(), {
                method: 'POST',
                body: JSON.stringify({ title })
            });
            if (!created || !created.id) {
                throw new Error('Add succeeded but the response did not contain a comment id.');
            }
            createdIds.push(created.id);
        }

        const comments = await listComments();
        console.log('\nReturned order:');
        console.log(comments.map((comment, index) => ({
            position: index + 1,
            id: comment.id,
            title: comment.title,
            createdTime: comment.createdTime,
            modifiedTime: comment.modifiedTime
        })));
        console.log('\nCreated probe IDs:');
        console.log(createdIds);
    } finally {
        for (const id of createdIds) {
            await deleteComment(id);
        }
    }
}

async function main() {
    const command = process.argv[2] || 'list';
    if (command === 'help' || command === '--help' || command === '-h') {
        usage();
        return;
    }

    requireValue('TICKTICK_BEARER_TOKEN', token);
    requireValue('TICKTICK_PROJECT_ID', projectId);
    requireValue('TICKTICK_TASK_ID', taskId);

    if (command === 'list') {
        await listComments();
        return;
    }

    if (command === 'add') {
        await addComment();
        return;
    }

    if (command === 'delete') {
        await deleteComment(commentId);
        return;
    }

    if (command === 'smoke') {
        await listComments();
        const created = await addComment();
        const createdId = created && created.id;
        if (!createdId) {
            throw new Error('Add succeeded but the response did not contain a comment id; refusing cleanup.');
        }
        await listComments();
        await deleteComment(createdId);
        await listComments();
        return;
    }

    if (command === 'order') {
        await probeOrder();
        return;
    }

    throw new Error(`Unknown command "${command}". Use list, add, delete, smoke, or help.`);
}

main().catch(error => {
    console.error(`\nProbe failed: ${error.message}`);
    process.exitCode = 1;
});
