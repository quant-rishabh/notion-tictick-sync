// Vercel Serverless Function - TickTick V2 API Proxy for batch/task
// This proxies requests to TickTick's internal API to avoid CORS issues

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cookie-T, X-Csrf-Token, X-Timezone');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const cookieT = req.headers['x-cookie-t'];
    const csrfToken = req.headers['x-csrf-token'];
    const timezone = req.headers['x-timezone'] || 'Asia/Calcutta';

    if (!cookieT || !csrfToken) {
        return res.status(400).json({ error: 'Missing authentication headers' });
    }

    try {
        const response = await fetch('https://api.ticktick.com/api/v2/batch/task', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Cookie': `t=${cookieT}; _csrf_token=${csrfToken}`,
                'x-csrftoken': csrfToken,
                'x-tz': timezone,
                'hl': 'en_US',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        
        if (response.ok) {
            return res.status(200).json(data);
        } else {
            return res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('TickTick API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
