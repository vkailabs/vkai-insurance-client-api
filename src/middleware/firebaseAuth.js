'use strict';

const { verifyIdToken } = require('../lib/firebase');
const prisma = require('../lib/prisma');

// Verifies the Firebase JWT from `Authorization: Bearer <token>`, upserts the
// matching local user, and attaches it as req.user. Used on all customer routes.
async function firebaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let decoded;
    try {
      decoded = await verifyIdToken(token);
    } catch (err) {
      req.log.warn({ err: err.message }, 'Firebase token verification failed');
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const firebaseUid = decoded.uid;
    const email = decoded.email || null;
    const name = decoded.name || decoded.displayName || email || 'Unknown';

    // Keep a local user row in sync with the Firebase identity so foreign keys
    // and dashboards have a stable id to reference.
    const user = await prisma.user.upsert({
      where: { firebaseUid },
      update: { email: email || undefined, name },
      create: { firebaseUid, email: email || `${firebaseUid}@unknown.local`, name },
    });

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { firebaseAuth };
