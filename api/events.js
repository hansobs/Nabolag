import { WebClient } from "@slack/web-api";

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

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
    // Open a DM channel with the user
    const dmChannel = await client.conversations.open({
      users: userId
    });

    if (!dmChannel.ok) {
      console.error('❌ Failed to open DM channel:', dmChannel.error);
      return { ok: false, error: dmChannel.error };
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

    // Send the welcome message
    const messageResult = await client.chat.postMessage({
      channel: dmChannel.channel.id,
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
      console.info(`✅ Velkomstbesked sendt til ${userId}`);
      return { ok: true, channel: dmChannel.channel.id, ts: messageResult.ts };
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
    const payload = req.body;
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
    console.info(`🔍 Bruger token: ${process.env.SLACK_BOT_TOKEN.startsWith("xoxp") ? "User Token (xoxp)" : "Bot Token (xoxb)"}`);
    console.info("🧩 Målgrupper:", USERGROUP_IDS);

    if (USERGROUP_IDS.length === 0) {
      console.warn("⚠️ Ingen brugergrupper konfigureret! Tjek USERGROUP_IDS miljøvariabel");
      return res.status(200).json({ ok: true, userId, warning: "No usergroups configured" });
    }

    // Validate the user exists and is active
    try {
      const userInfo = await client.users.info({ user: userId });
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

    for (const ug of USERGROUP_IDS) {
      try {
        // Fetch existing members
        const current = await client.usergroups.users.list({ usergroup: ug });

        // Check if user is already in the group
        if (current.users && current.users.includes(userId)) {
          console.info(`👤 Bruger ${userId} er allerede i brugergruppe ${ug}`);
          ugResults.push({ usergroup: ug, ok: true, updated: false, reason: 'already a member' });
          continue;
        }

        // Clean the current users list - remove bot and any invalid entries
        const cleanCurrentUsers = (current.users || [])
          .filter(id => {
            const isValid = id && 
                           id !== botUserId && 
                           id.startsWith('U') && 
                           id.length > 10;
            return isValid;
          });
        
        console.info(`🧹 Tilføjer ${userId} til brugergruppe ${ug}`);
        
        // Add the new user
        const updatedUsers = [...cleanCurrentUsers, userId];

        const result = await client.usergroups.users.update({
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

    // Send welcome message if user was added to any groups
    let welcomeMessageResult = null;
    if (addedToGroups.length > 0) {
      console.info(`📨 Sender velkomstbesked til ${userId} for grupper: ${addedToGroups.join(', ')}`);
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
