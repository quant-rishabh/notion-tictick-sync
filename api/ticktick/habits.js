// Server-side proxy for TickTick habit APIs.
// Endpoint: /api/ticktick/habits

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const body = req.body || {};
    const cookieT = body.ticktick_cookie_t || '';
    const csrf = body.ticktick_csrf || '';
    const token = body.ticktick_token ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        process.env.TICKTICK_BEARER_TOKEN ||
        '';

    try {
        let apiUrl = 'https://api.ticktick.com/open/v1/habit';
        let method = 'GET';
        let headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
        let requestBody;

        if (body.action === 'query_checkins') {
            if (!cookieT) {
                return res.status(400).json({ error: 'Missing TickTick session cookie' });
            }
            apiUrl = 'https://api.ticktick.com/api/v2/habitCheckins/query';
            method = 'POST';
            headers = {
                Cookie: `t=${cookieT}`,
                'Content-Type': 'application/json',
                'x-csrftoken': csrf
            };
            requestBody = JSON.stringify({
                habitIds: body.habitIds,
                afterStamp: Number(body.afterStamp)
            });
        } else if (body.action === 'get_habit_detail') {
            if (!body.habitId) {
                return res.status(400).json({ error: 'Habit ID is required' });
            }
            apiUrl = `https://api.ticktick.com/open/v1/habit/${encodeURIComponent(body.habitId)}`;
        } else if (body.action === 'get_habit_sections') {
            apiUrl = 'https://api.ticktick.com/open/v1/habit/sections';
        } else if (body.action === 'checkin') {
            if (!token || !body.habitId || !body.stamp) {
                return res.status(400).json({ error: 'Token, habitId, and stamp are required' });
            }
            apiUrl = `https://api.ticktick.com/open/v1/habit/${encodeURIComponent(body.habitId)}/checkin`;
            method = 'POST';
            requestBody = JSON.stringify({
                stamp: Number(body.stamp),
                value: body.value === undefined ? 1 : body.value,
                goal: body.goal || 1,
                status: body.status
            });
        } else if (!token) {
            return res.status(401).json({ error: 'Missing TickTick API token' });
        }

        const response = await fetch(apiUrl, {
            method,
            headers,
            body: requestBody
        });
        const data = await response.text();
        res.status(response.status);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
        return res.send(data);
    } catch (error) {
        console.error('[HABITS API] Error:', error.message);
        return res.status(502).json({ error: 'TickTick request failed', details: error.message });
    }
}
