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

  const { data: me } = await supabase
    .from('users')
    .select('*')
    .eq('uid', req.uid)
    .maybeSingle();

  const { data: partner } = await supabase
    .from('users')
    .select('*')
    .eq('invite_code', code)
    .maybeSingle();

  if (!me || !partner) return res.status(404).json({ error: 'not_found' });
  if (partner.uid === me.uid) return res.status(400).json({ error: 'cannot_pair_self' });

  // If already paired with each other, return current user DTO
  if (me.partner_uid === partner.uid && partner.partner_uid === me.uid) {
    return res.json(await toUserDto(me));
  }

  // Atomic pairing: only succeed if both sides are currently unpaired
  const { data: updatedMe, error: errMe } = await supabase
    .from('users')
    .update({ partner_uid: partner.uid })
    .eq('uid', me.uid)
    .is('partner_uid', null)
    .select('*');

  if (errMe || !updatedMe || updatedMe.length === 0) {
    return res.status(409).json({ error: 'already_paired' });
  }

  const { data: updatedPartner, error: errPartner } = await supabase
    .from('users')
    .update({ partner_uid: me.uid })
    .eq('uid', partner.uid)
    .is('partner_uid', null)
    .select('*');

  if (errPartner || !updatedPartner || updatedPartner.length === 0) {
    // Rollback me
    await supabase.from('users').update({ partner_uid: null }).eq('uid', me.uid);
    return res.status(409).json({ error: 'partner_already_paired' });
  }

  const pairedUser = updatedMe[0];
  pairedUser.partner_uid = partner.uid;
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
  const { data: partner } = await supabase
    .from('users')
    .select('*')
    .eq('uid', sender.partner_uid)
    .maybeSingle();

  const tokens = partner?.fcm_tokens?.map((t) => t.token) ?? [];
  if (!tokens.length) return;

  try {
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

    // Prune dead tokens
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
      const remaining = partner.fcm_tokens.filter((t) => !dead.includes(t.token));
      await supabase
        .from('users')
        .update({ fcm_tokens: remaining })
        .eq('uid', partner.uid);
    }
  } catch (err) {
    console.error('[FCM] Error sending multicast notification:', err.message);
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

  notifyPartner(me, scribble).catch((e) => console.error('FCM error', e));
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
