// api/events.js
// Vercel serverless handler for Slack team_join and user_change events
// - Verifies Slack signature
// - Handles url_verification
// - Adds users to usergroups + invites to channels

const crypto = require('crypto');

// ------------------- Helpers -------------------

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySlackRequest(rawBody, headers) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];

  if (!ts || !sig) return false;

  // Protect against replay attacks (5 minutes)
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > fiveMinutes) return false;

  const base = `v0:${ts}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(base);
  const mySig = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(sig));
}

async function slackApi(path, bodyObj) {
  const token = process.env.SLACK_BOT_TOKEN;
  const res = await fetch(`https://slack.com/api/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(bodyObj)
  });
  return res.json();
}

async function addUserToUsergroups(userId) {
  const ugIDs = (process.env.USERGROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!ugIDs.length) return { skipped: true };

  const botUserId = process.env.BOT_USER_ID; // set this in Vercel
  const results = [];

  for (const ug of ugIDs) {
    // Get current members
    const listRes = await slackApi('usergroups.users.list', { usergroup: ug });
    if (!listRes.ok) {
      results.push({ usergroup: ug, ok: false, error: listRes.error });
      continue;
    }

    // Clean up current user list
    const currentUsers = (listRes.users || [])
      .filter(id => id && id !== botUserId); // remove bot and invalid IDs

    // Skip if user already in group
    if (currentUsers.includes(userId)) {
      results.push({ usergroup: ug, ok: true, updated: false, reason: 'already a member' });
      continue;
    }

    // Add user to list
    const newUsers = [...currentUsers, userId].join(',');

    // Update usergroup membership
    const updRes = await slackApi('usergroups.users.update', {
      usergroup: ug,
      users: newUsers,
    });

    if (!updRes.ok) {
      results.push({ usergroup: ug, ok: false, error: updRes.error });
    } else {
      results.push({ usergroup: ug, ok: true, updated: true });
    }
  }

  return results;
}

async function inviteUserToChannels(userId) {
  const chIDs = (process.env.CHANNEL_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!chIDs.length) return { skipped: true };

  const results = [];
  for (const ch of chIDs) {
    const inviteRes = await slackApi('conversations.invite', { channel: ch, users: userId }).catch(e => ({ ok:false, error: e.message }));
    if (inviteRes && inviteRes.ok) {
      results.push({ channel: ch, ok: true, invited: true });
    } else {
      results.push({ channel: ch, ok: false, error: inviteRes ? inviteRes.error : 'invite-failed' });
    }
  }
  return results;
}

// ------------------- Main Handler -------------------

module.exports = async (req, res) => {
  try {
    const rawBuf = await getRawBody(req);
    const rawBody = rawBuf.toString('utf8');

    // Verify Slack request
    if (!verifySlackRequest(rawBody, req.headers)) {
      console.warn('Slack verification failed');
      return res.status(401).send('verification failed');
    }

    // Parse payload
    const payload = JSON.parse(rawBody);
    console.log('Received Slack payload:', JSON.stringify(payload, null, 2));

    // Handle url_verification (initial setup)
    if (payload.type === 'url_verification' && payload.challenge) {
      res.setHeader('content-type','text/plain');
      return res.status(200).send(payload.challenge);
    }

    // Only handle event callbacks
    if (payload.type !== 'event_callback') {
      return res.status(200).send('ok');
    }

    const event = payload.event || {};
    const user = event.user || event.user?.user; // handle user_change nested object
    const userId = user?.id;

    if (!userId) {
      console.log('No userId found in event, ignoring.');
      return res.status(200).send('ignored');
    }

    // ---------- TEAM_JOIN ----------
    if (event.type === 'team_join') {
      const ugResult = await addUserToUsergroups(userId);
      const chResult = await inviteUserToChannels(userId);
      console.log('team_join processed:', { userId, ugResult, chResult });
      return res.status(200).json({ ok: true, eventType: 'team_join', user: userId, usergroups: ugResult, channels: chResult });
    }

    // ---------- USER_CHANGE (reactivated) ----------
    if (event.type === 'user_change' && user.deleted === false) {
      const ugResult = await addUserToUsergroups(userId);
      const chResult = await inviteUserToChannels(userId);
      console.log('user_change (reactivated) processed:', { userId, ugResult, chResult });
      return res.status(200).json({ ok: true, eventType: 'user_reactivated', user: userId, usergroups: ugResult, channels: chResult });
    }

    // Other events are ignored
    return res.status(200).send('ignored');

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
