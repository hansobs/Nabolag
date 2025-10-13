// api/events.js
// Vercel serverless handler for Slack team_join events.
// - Verifies Slack signature
// - Handles url_verification
// - On team_join: adds user to usergroups and invites to channels

const crypto = require('crypto');

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

  // Use constant-time compare
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
  const ugIDs = (process.env.USERGROUP_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!ugIDs.length) return { skipped: true };

  const results = [];

  for (const ug of ugIDs) {
    // Get current members
    const listRes = await slackApi('usergroups.users.list', { usergroup: ug });
    if (!listRes.ok) {
      results.push({ usergroup: ug, ok: false, error: listRes.error });
      continue;
    }
    const currentUsers = listRes.users || []; // array of user IDs
    if (currentUsers.includes(userId)) {
      results.push({ usergroup: ug, ok: true, updated: false, reason: 'already a member' });
      continue;
    }
    const newUsers = [...currentUsers, userId].join(',');
    const updRes = await slackApi('usergroups.users.update', { usergroup: ug, users: newUsers });
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
    // For public channels, conversations.invite should work if bot is a member.
    // If bot is not member, conversations.join or inviting the bot first could be necessary.
    const inviteRes = await slackApi('conversations.invite', { channel: ch, users: userId }).catch(e => ({ ok:false, error: e.message }));
    if (inviteRes && inviteRes.ok) {
      results.push({ channel: ch, ok: true, invited: true });
    } else {
      // If invite failed because bot not in channel, try conversations.join (for bot) then invite again
      results.push({ channel: ch, ok: false, error: inviteRes ? inviteRes.error : 'invite-failed' });
    }
  }
  return results;
}

module.exports = async (req, res) => {
  try {
    const rawBuf = await getRawBody(req);
    const rawBody = rawBuf.toString('utf8');

    // Verify Slack request
    if (!verifySlackRequest(rawBody, req.headers)) {
      // Slack will test with url_verification which doesn't have signature; but Slack sends signature for that too.
      // Fail safely if verification fails.
      console.warn('Slack verification failed');
      return res.status(401).send('verification failed');
    }

    const payload = JSON.parse(rawBody);

    // Handle url_verification (initial verification)
    if (payload.type === 'url_verification' && payload.challenge) {
      res.setHeader('content-type','text/plain');
      return res.status(200).send(payload.challenge);
    }

    // Only handle event callbacks
    if (payload.type !== 'event_callback') {
      return res.status(200).send('ok');
    }

    const event = payload.event || {};
    // Only act on team_join
    if (event.type === 'team_join' && event.user && event.user.id) {
      const userId = event.user.id;

      // Do the work (add to usergroups + invite to channels)
      const ugResult = await addUserToUsergroups(userId);
      const chResult = await inviteUserToChannels(userId);

      // Optionally: send a welcome message (uncomment with chat:write scope)
      // await slackApi('chat.postMessage', { channel: userId, text: "Velkommen!" });

      return res.status(200).json({ ok: true, user: userId, usergroups: ugResult, channels: chResult });
    }

    // For other events: respond OK quickly
    return res.status(200).send('ignored');
  } catch (err) {
    console.error('handler error', err);
    return res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
