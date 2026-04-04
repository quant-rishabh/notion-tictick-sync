// Vercel serverless function for TickTick Habits API proxy
// Endpoint: /api/ticktick/habits

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    // Get credentials from query params (GET) or body (POST)
    let cookieT = req.query.t || '';
    let csrf = req.query.csrf || '';
    let body = req.body || {};

    if (body.ticktick_cookie_t) cookieT = body.ticktick_cookie_t;
    if (body.ticktick_csrf) csrf = body.ticktick_csrf;

    if (!cookieT || !csrf) {
        return res.status(400).json({
            error: 'Missing credentials',
            help: 'Pass t and csrf in query params or body'
        });
    }

    const headers = {
        'Cookie': `t=${cookieT}`,
        'x-csrf-token': csrf,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    try {
        let apiUrl = 'https://api.ticktick.com/api/v2/habits';
        let method = 'GET';
        let requestBody = null;

        if (body.action === 'query_checkins') {
            apiUrl = 'https://api.ticktick.com/api/v2/habitCheckins/query';
            method = 'POST';
            requestBody = JSON.stringify({
                habitIds: body.habitIds,
                afterStamp: body.afterStamp
            });
        } else if (body.action === 'checkin') {
            apiUrl = 'https://api.ticktick.com/api/v2/habitCheckins';
            method = 'POST';
            requestBody = JSON.stringify({
                habitId: body.habitId,
                checkinStamp: body.stamp,
                value: body.value,
                status: body.status,
                goal: body.goal
            });
        }

        console.log(`[HABITS API] ${method} ${apiUrl}`);

        const response = await fetch(apiUrl, {
            method,
            headers,
            body: requestBody
        });

        const data = await response.text();
        
        res.status(response.status);
        res.setHeader('Content-Type', 'application/json');
        return res.send(data);

    } catch (error) {
        console.error('[HABITS API] Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
}
