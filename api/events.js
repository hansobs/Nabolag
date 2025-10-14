import { WebClient } from "@slack/web-api";

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

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

    console.info(`⚙️ Processing ${triggeredBy} for ${userId}`);
    console.info(`🔍 Using token: ${process.env.SLACK_BOT_TOKEN.startsWith("xoxp") ? "User Token (xoxp)" : "Bot Token (xoxb)"}`);
    console.info("🔧 Raw USERGROUP_IDS env var:", process.env.USERGROUP_IDS);
    console.info("🧩 Target usergroups:", USERGROUP_IDS);

    if (USERGROUP_IDS.length === 0) {
      console.warn("⚠️ No usergroups configured! Check USERGROUP_IDS environment variable");
      return res.status(200).json({ ok: true, userId, warning: "No usergroups configured" });
    }

    const ugResults = [];

    for (const ug of USERGROUP_IDS) {
      try {
        // Fetch existing members
        const current = await client.usergroups.users.list({ usergroup: ug });
        console.info(`👥 Current members of ${ug}:`, current.users);

        // Check if user is already in the group
        if (current.users && current.users.includes(userId)) {
          console.info(`👤 User ${userId} already in usergroup ${ug}`);
          ugResults.push({ usergroup: ug, ok: true, updated: false, reason: 'already a member' });
          continue;
        }

        // Add the new user
        const updatedUsers = Array.from(new Set([...(current.users || []), userId]));
        console.info(`🧮 Attempting to update ${ug} with users:`, updatedUsers);

        const result = await client.usergroups.users.update({
          usergroup: ug,
          users: updatedUsers.join(","),
        });

        console.info(`✅ usergroups.users.update response for ${ug}:`, result);
        ugResults.push({ usergroup: ug, ok: result.ok, updated: true, error: result.error });
      } catch (ugErr) {
        console.error(`❌ Error updating usergroup ${ug}:`, ugErr.data || ugErr.message || ugErr);
        ugResults.push({ usergroup: ug, ok: false, error: ugErr.data?.error || ugErr.message });
      }
    }

    console.info(`🎯 Finished processing ${triggeredBy} for ${userId}`, { ugResults });

    return res.status(200).json({ ok: true, userId, ugResults });
  } catch (err) {
    console.error("💥 Handler error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
