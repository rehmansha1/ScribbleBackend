import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import admin from './firebase.js';
import { requireAuth } from './auth.js';
import { supabase } from './supabase.js';
import { makeCode } from './models.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024, files: 1 },
});

const sendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req) => req.uid,
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => buf && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);

const toScribbleDto = (s) => ({
  id: String(s.id),
  fromUid: s.from_uid,
  createdAt: new Date(s.created_at).getTime(),
});

async function toUserDto(user) {
  let partnerName = null;
  if (user.partner_uid) {
    const { data: p } = await supabase
      .from('users')
      .select('display_name')
      .eq('uid', user.partner_uid)
      .maybeSingle();
    if (p) partnerName = p.display_name;
  }

  return {
    uid: user.uid,
    displayName: user.display_name,
    inviteCode: user.invite_code,
    partner: partnerName ? { displayName: partnerName } : null,
  };
}

// ---- Users -----------------------------------------------------------

router.post('/users/register', async (req, res) => {
  const { displayName } = z
    .object({ displayName: z.string().trim().min(1).max(40) })
    .parse(req.body);

  // Check if user already exists
  const { data: existing, error: findError } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();

  if (findError) throw findError;

  let user;
  if (existing) {
    const { data, error } = await supabase
      .from('users')
      .update({ display_name: displayName, updated_at: new Date().toISOString() })
      .eq('uid', req.uid)
      .select('*')
      .single();
    if (error) throw error;
    user = data;
  } else {
    // Generate unique invite code and insert
    for (let i = 0; i < 5 && !user; i++) {
      const inviteCode = makeCode();
      const { data, error } = await supabase
        .from('users')
        .insert({
          uid: req.uid,
          display_name: displayName,
          invite_code: inviteCode,
        })
        .select('*')
        .single();

      if (!error) {
        user = data;
        break;
      }
      // Postgres unique constraint violation code is 23505
      if (error.code !== '23505') throw error;
    }
  }

  if (!user) {
    return res.status(500).json({ error: 'failed_to_register_user' });
  }

  res.json(await toUserDto(user));
});

router.get('/users/me', async (req, res) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();

  if (error) throw error;
  if (!user) return res.status(404).json({ error: 'not_registered' });
  res.json(await toUserDto(user));
});

router.put('/users/me/fcm-token', async (req, res) => {
  const { token } = z
    .object({ token: z.string().min(20).max(4096) })
    .parse(req.body);

  const { data: me, error } = await supabase
    .from('users')
    .select('fcm_tokens')
    .eq('uid', req.uid)
    .maybeSingle();

  if (error) throw error;
  if (!me) return res.status(404).json({ error: 'not_registered' });

  const currentTokens = (me.fcm_tokens || []).filter((t) => t.token !== token);
  currentTokens.push({ token, updatedAt: new Date().toISOString() });
  const updatedTokens = currentTokens.slice(-5);

  const { error: updateError } = await supabase
    .from('users')
    .update({ fcm_tokens: updatedTokens })
    .eq('uid', req.uid);

  if (updateError) throw updateError;
  res.sendStatus(204);
});

// ---- Pairing ---------------------------------------------------------

router.post('/pair', async (req, res) => {
  const { code } = z
    .object({ code: z.string().trim().toUpperCase().length(6) })
    .parse(req.body);
  console.log("code:", code);
  const { data: me } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();
  console.log("hello there 1 me:", JSON.stringify(me));
  const { data: partner } = await supabase
    .from('users')
    .select('*')
    .eq('invite_code', code)
    .maybeSingle();
  console.log("hello there 2 partner:", JSON.stringify(partner));

  if (!me || !partner) return res.status(404).json({ error: 'not_found' });
  if (partner.uid === me.uid) return res.status(400).json({ error: 'cannot_pair_self' });

  // If already paired with each other, return current user DTO
  if (me.partner_uid === partner.uid && partner.partner_uid === me.uid) {
    console.log("hello 3 already paired");
    return res.json(await toUserDto(me));
  }

  // Atomic pairing: only succeed if both sides are currently unpaired
  const { data: updatedMe, error: errMe } = await supabase
    .from('users')
    .update({ partner_uid: partner.uid })
    .eq('uid', me.uid)
    .is('partner_uid', null)
    .select('*');
  console.log("hello 4 updatedMe:", JSON.stringify(updatedMe));
  if (errMe || !updatedMe || updatedMe.length === 0) {
    console.log("hello 5 failed me update error:", errMe);
    return res.status(409).json({ error: 'already_paired' });
  }

  const { data: updatedPartner, error: errPartner } = await supabase
    .from('users')
    .update({ partner_uid: me.uid })
    .eq('uid', partner.uid)
    .is('partner_uid', null)
    .select('*');
  console.log("hello 6 updatedPartner:", JSON.stringify(updatedPartner));
  if (errPartner || !updatedPartner || updatedPartner.length === 0) {
    // Rollback me
    await supabase.from('users').update({ partner_uid: null }).eq('uid', me.uid);
    console.log("hello 7 failed partner update rollback error:", errPartner);
    return res.status(409).json({ error: 'partner_already_paired' });
  }

  const pairedUser = updatedMe[0];
  pairedUser.partner_uid = partner.uid;
  console.log("hello 8 pairedUser:", JSON.stringify(pairedUser));

  // Notify the partner that someone just paired with them (instant update)
  const partnerTokens = partner.fcm_tokens?.map((t) => t.token) ?? [];
  if (partnerTokens.length) {
    try {
      await admin.messaging().sendEachForMulticast({
        tokens: partnerTokens,
        data: {
          type: 'paired',
          partnerName: me.display_name,
        },
        android: { priority: 'high' },
      });
    } catch (e) {
      console.error('Failed to notify partner about pairing:', e);
    }
  }

  res.json(await toUserDto(pairedUser));
});

router.delete('/pair', async (req, res) => {
  const { data: me } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();
  if (me?.partner_uid) {
    await supabase
      .from('users')
      .update({ partner_uid: null })
      .eq('uid', me.partner_uid)
      .eq('partner_uid', me.uid);

    await supabase
      .from('users')
      .update({ partner_uid: null })
      .eq('uid', me.uid);
  }
  res.sendStatus(204);
});

// ---- Scribbles -------------------------------------------------------

async function notifyPartner(sender, scribble) {
  const startTotal = Date.now();
  console.log(`[notifyPartner] 🚀 Starting notification dispatch for scribble #${scribble.id} at ${new Date().toISOString()}`);

  // Step 1: Query Supabase for partner profile
  const t0 = Date.now();
  const { data: partner } = await supabase
    .from('users')
    .select('*')
    .eq('uid', sender.partner_uid)
    .maybeSingle();
  const partnerQueryTime = Date.now() - t0;
  console.log(`[notifyPartner] ⏱️ Step 1 (Fetch partner from Supabase): ${partnerQueryTime}ms`);

  const tokens = partner?.fcm_tokens?.map((t) => t.token) ?? [];
  if (!tokens.length) {
    console.log(`[notifyPartner] ⚠️ No FCM tokens found for partner ${sender.partner_uid} (Finished in ${Date.now() - startTotal}ms)`);
    return;
  }
  console.log(`[notifyPartner] Found ${tokens.length} device token(s) to notify.`);

  try {
    // Step 2: Send FCM Multicast
    const tFcm = Date.now();
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        type: 'scribble',
        scribbleId: String(scribble.id),
        fromName: sender.display_name,
        createdAt: String(new Date(scribble.created_at).getTime()),
      },
      android: {
        priority: 'high',
        ttl: 24 * 60 * 60 * 1000,
      },
    });
    const fcmTime = Date.now() - tFcm;
    console.log(`[notifyPartner] ⏱️ Step 2 (FCM sendEachForMulticast): ${fcmTime}ms (Success: ${resp.successCount}, Failure: ${resp.failureCount})`);

    // Step 3: Prune dead tokens if any
    const dead = [];
    resp.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (
        !r.success &&
        (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token')
      ) {
        dead.push(tokens[i]);
      }
    });

    if (dead.length) {
      const tPrune = Date.now();
      const remaining = partner.fcm_tokens.filter((t) => !dead.includes(t.token));
      await supabase
        .from('users')
        .update({ fcm_tokens: remaining })
        .eq('uid', partner.uid);
      const pruneTime = Date.now() - tPrune;
      console.log(`[notifyPartner] ⏱️ Step 3 (Prune ${dead.length} dead token(s) in Supabase): ${pruneTime}ms`);
    } else {
      console.log(`[notifyPartner] ⏱️ Step 3 (Token check): All tokens valid, no cleanup needed.`);
    }

    const totalTime = Date.now() - startTotal;
    console.log(`[notifyPartner] ✅ Total notifyPartner execution time: ${totalTime}ms`);
  } catch (err) {
    console.error(`[FCM] ❌ Error sending multicast notification after ${Date.now() - startTotal}ms:`, err.message);
  }
}

router.post('/scribbles', sendLimiter, upload.single('image'), async (req, res) => {
  if (!req.file || !isPng(req.file.buffer)) {
    return res.status(400).json({ error: 'png_required' });
  }

  const { data: me } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();

  if (!me?.partner_uid) return res.status(409).json({ error: 'not_paired' });

  const { data: scribble, error } = await supabase
    .from('scribbles')
    .insert({
      from_uid: me.uid,
      to_uid: me.partner_uid,
      image_base64: req.file.buffer.toString('base64'),
      content_type: 'image/png',
    })
    .select('id, from_uid, created_at')
    .single();

  if (error) throw error;

  // Await FCM notification so it isn't dropped on Render's free tier before the process idles
  await notifyPartner(me, scribble);
  res.status(201).json(toScribbleDto(scribble));
});

router.get('/scribbles/latest', async (req, res) => {
  const { data: s, error } = await supabase
    .from('scribbles')
    .select('id, from_uid, created_at')
    .eq('to_uid', req.uid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!s) return res.sendStatus(204);
  res.json(toScribbleDto(s));
});

router.get('/scribbles/:id/image', async (req, res) => {
  const { data: s, error } = await supabase
    .from('scribbles')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !s) return res.sendStatus(404);
  if (s.to_uid !== req.uid && s.from_uid !== req.uid) return res.sendStatus(404);

  const imageBuffer = Buffer.from(s.image_base64, 'base64');
  res
    .set('Content-Type', s.content_type || 'image/png')
    .set('Cache-Control', 'private, max-age=31536000, immutable')
    .send(imageBuffer);
});

export default router;
