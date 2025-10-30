import { WebClient } from "@slack/web-api";
import crypto from "crypto";

// If running under Next.js API Routes, disable built-in body parsing
export const config = {
  api: {
    bodyParser: false,
  },
};

// Create two clients - one for each token type
const userClient = new WebClient(process.env.SLACK_USER_TOKEN); // xoxp token
const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);   // xoxb token

// Helpers for Slack request verification
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

  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(sig));
  } catch (_) {
    return false;
  }
}

// Simple in-memory cache to prevent duplicate processing
const recentlyProcessed = new Map();
const DUPLICATE_WINDOW = 30000; // 30 seconds

// Usergroup information for welcome messages (in Danish)
const USERGROUP_INFO = {
  'S09KJF9AT4N': {
    name: 'Arrangementer',
    description: 'Denne gruppe er til planlægning og koordinering af arrangementer. Du vil modtage opdateringer om kommende begivenheder og kan deltage i organiseringen af disse.',
    emoji: '🎉'
  },
  'S09KQ6XNSBE': {
    name: 'Nabolag',
    description: 'Velkommen til nabolagsgruppen! Her forbinder alle fællesskabsmedlemmer sig, deler opdateringer og vender stort og småt.',
    emoji: '🏘️'
  }
};

async function sendWelcomeMessage(userId, addedGroups) {
  try {
    let dmChannelId = null;

    // Try method 1: conversations.open using bot client
    try {
      const dmChannel = await botClient.conversations.open({
        users: userId
      });
      
      if (dmChannel.ok) {
        dmChannelId = dmChannel.channel.id;
        console.info(`✅ Opened DM channel via bot conversations.open: ${dmChannelId}`);
      }
    } catch (convError) {
      console.warn(`⚠️ Bot conversations.open failed, trying fallback:`, convError.message);
    }

    // Fallback method 2: Send directly to user ID
    if (!dmChannelId) {
      dmChannelId = userId;
      console.info(`🔄 Using fallback: sending directly to user ID ${userId}`);
    }

    // Build the welcome message in Danish
    let welcomeText = `👋 Velkommen til *Foreningen Nabolag*!\n\n`;
    welcomeText += `Jeg har automatisk tilføjet dig til følgende brugergrupper:\n\n`;

    addedGroups.forEach(groupId => {
      const groupInfo = USERGROUP_INFO[groupId];
      if (groupInfo) {
        welcomeText += `${groupInfo.emoji} *@${groupInfo.name}*\n`;
        welcomeText += `${groupInfo.description}\n\n`;
      } else {
        welcomeText += `📋 *Brugergruppe: ${groupId}*\n`;
        welcomeText += `Du er blevet tilføjet til denne gruppe for fællesskabsopdateringer.\n\n`;
      }
    });

    welcomeText += `💡 *Hvad betyder det:*\n`;
    welcomeText += `• Du bliver notificeret når disse grupper bliver nævnt\n`;
    welcomeText += `• Du kan bruge @${USERGROUP_INFO['S09KJF9AT4N']?.name.toLowerCase() || 'gruppe-navn'} til at sende beskeder til alle i den gruppe\n`;
    welcomeText += `• Du vil modtage relevante opdateringer og meddelelser\n\n`;
    
    welcomeText += `🤝 Hvis du har spørgsmål om fællesskabet eller disse grupper, så spørg endelig!\n\n`;
    welcomeText += `_Du kan administrere dine notifikationsindstillinger i dine Slack-indstillinger._`;

    // Send the welcome message using BOT client
    const messageResult = await botClient.chat.postMessage({
      channel: dmChannelId,
      text: welcomeText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: welcomeText
          }
        },
        {
          type: "divider"
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "🤖 Dette er en automatisk velkomstbesked fra Nabolag fællesskabsbotten."
            }
          ]
        }
      ]
    });

    if (messageResult.ok) {
      console.info(`✅ Velkomstbesked sendt som bot til ${userId} via kanal ${dmChannelId}`);
      return { ok: true, channel: dmChannelId, ts: messageResult.ts };
    } else {
      console.error(`❌ Kunne ikke sende velkomstbesked til ${userId}:`, messageResult.error);
      return { ok: false, error: messageResult.error };
    }

  } catch (error) {
    console.error(`❌ Fejl ved afsendelse af velkomstbesked til ${userId}:`, error);
    return { ok: false, error: error.message };
  }
}

export default async function handler(req, res) {
  try {
    // Read raw body for Slack signature verification
    const rawBuf = await getRawBody(req);
    const rawBody = rawBuf.toString('utf8');

    // Verify Slack request signature
    if (!verifySlackRequest(rawBody, req.headers)) {
      console.warn('Slack verification failed');
      return res.status(401).send('verification failed');
    }

    // Parse payload after verification
    const payload = JSON.parse(rawBody);

    // Handle initial URL verification challenge
    if (payload.type === 'url_verification' && payload.challenge) {
      res.setHeader('content-type', 'text/plain');
      return res.status(200).send(payload.challenge);
    }
    console.info("📩 Received Slack payload:", JSON.stringify(payload, null, 2));

    const event = payload.event;
    if (!event) return res.status(200).send("No event");

    const user = event.user;
    const userId = user?.id;

    // Define USERGROUP_IDS at the top level
    const USERGROUP_IDS = (process.env.USERGROUP_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    // Which event type?
    const type = event.type;
    let triggeredBy = "";
    if (type === "team_join") triggeredBy = "team_join";
    else if (type === "user_change" && user && (!user.deleted && user.is_restricted === false)) triggeredBy = "user_change (reactivated)";

    if (!triggeredBy) {
      console.info("ℹ️ Skipping event:", type);
      return res.status(200).send("Skipped");
    }

    // Check for recent processing to avoid duplicates
    const now = Date.now();
    
    if (recentlyProcessed.has(userId)) {
      const lastProcessed = recentlyProcessed.get(userId);
      if (now - lastProcessed < DUPLICATE_WINDOW) {
        console.info(`⏰ Bruger ${userId} blev behandlet for nylig (${now - lastProcessed}ms siden), springer ${triggeredBy} over`);
        return res.status(200).json({ ok: true, userId, skipped: true, reason: 'recently_processed' });
      }
    }

    // Mark as being processed
    recentlyProcessed.set(userId, now);
    
    // Clean up old entries
    for (const [key, timestamp] of recentlyProcessed.entries()) {
      if (now - timestamp > DUPLICATE_WINDOW) {
        recentlyProcessed.delete(key);
      }
    }

    console.info(`⚙️ Behandler ${triggeredBy} for ${userId}`);
    console.info(`🔍 Bruger user token: ${process.env.SLACK_USER_TOKEN?.startsWith("xoxp") ? "User Token (xoxp)" : "Invalid/Missing"}`);
    console.info(`🤖 Bruger bot token: ${process.env.SLACK_BOT_TOKEN?.startsWith("xoxb") ? "Bot Token (xoxb)" : "Invalid/Missing"}`);
    console.info("🧩 Målgrupper:", USERGROUP_IDS);

    if (USERGROUP_IDS.length === 0) {
      console.warn("⚠️ Ingen brugergrupper konfigureret! Tjek USERGROUP_IDS miljøvariabel");
      return res.status(200).json({ ok: true, userId, warning: "No usergroups configured" });
    }

    // Validate the user exists and is active (using user client)
    try {
      const userInfo = await userClient.users.info({ user: userId });
      console.info(`👤 Brugerinfo for ${userId}:`, {
        name: userInfo.user?.name,
        real_name: userInfo.user?.real_name,
        deleted: userInfo.user?.deleted,
        is_restricted: userInfo.user?.is_restricted,
        is_ultra_restricted: userInfo.user?.is_ultra_restricted,
        is_bot: userInfo.user?.is_bot
      });
      
      if (userInfo.user?.deleted) {
        console.warn(`⚠️ Bruger ${userId} er slettet, springer over`);
        return res.status(200).json({ ok: true, userId, warning: "User is deleted" });
      }
    } catch (userErr) {
      console.error(`❌ Fejl ved hentning af brugerinfo for ${userId}:`, userErr.data || userErr.message);
    }

    const ugResults = [];
    const addedToGroups = [];
    const botUserId = process.env.BOT_USER_ID || 'U09KDFQH3EF';

    // Use USER CLIENT for usergroup operations
    for (const ug of USERGROUP_IDS) {
      try {
        // Fetch existing members using user client
        const current = await userClient.usergroups.users.list({ usergroup: ug });

        // Check if user is already in the group
        if (current.users && current.users.includes(userId)) {
          console.info(`👤 Bruger ${userId} er allerede i brugergruppe ${ug}`);
          ugResults.push({ usergroup: ug, ok: true, updated: false, reason: 'already a member' });
          continue;
        }

        const cleanCurrentUsers = (current.users || [])
          .filter(id => {
            // Only filter out invalid user IDs, keep ALL valid users
            return id && 
                   id.startsWith('U') && 
                   id.length > 10;
          });
        
        console.info(`🧹 Tilføjer ${userId} til brugergruppe ${ug}`);
        
        // Add the new user using user client
        const updatedUsers = [...cleanCurrentUsers, userId];
        
        const result = await userClient.usergroups.users.update({
          usergroup: ug,
          users: updatedUsers.join(","),
        });

        if (result.ok) {
          console.info(`✅ Tilføjede succesfuldt ${userId} til ${ug}`);
          ugResults.push({ usergroup: ug, ok: true, updated: true });
          addedToGroups.push(ug);
        } else {
          ugResults.push({ usergroup: ug, ok: false, error: result.error });
        }
        
      } catch (ugErr) {
        console.error(`❌ Fejl ved opdatering af brugergruppe ${ug}:`, ugErr.data || ugErr.message || ugErr);
        ugResults.push({ usergroup: ug, ok: false, error: ugErr.data?.error || ugErr.message });
      }
    }

    // Send welcome message if user was added to any groups (using BOT client)
    let welcomeMessageResult = null;
    if (addedToGroups.length > 0) {
      console.info(`📨 Sender velkomstbesked som bot til ${userId} for grupper: ${addedToGroups.join(', ')}`);
      welcomeMessageResult = await sendWelcomeMessage(userId, addedToGroups);
    }

    console.info(`🎯 Færdig med behandling af ${triggeredBy} for ${userId}`, { 
      ugResults, 
      welcomeMessageSent: welcomeMessageResult?.ok || false 
    });

    return res.status(200).json({ 
      ok: true, 
      userId, 
      ugResults, 
      processedEvent: triggeredBy,
      welcomeMessage: welcomeMessageResult
    });
  } catch (err) {
    console.error("💥 Handler error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
