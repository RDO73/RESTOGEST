import crypto from 'node:crypto';

/**
 * Hachage sécurisé des mots de passe.
 * Utilise Argon2id si la bibliothèque native est disponible, avec fallback scrypt sécurisé.
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    const argon2 = await import('argon2');
    return await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });
  } catch {
    // Fallback crypto natif Node.js
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
    return `$scrypt$v=1$m=65536$${salt}$${derivedKey}`;
  }
}

/**
 * Vérification de mot de passe
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (hash.startsWith('$argon2')) {
    try {
      const argon2 = await import('argon2');
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  if (hash.startsWith('$scrypt$')) {
    const parts = hash.split('$');
    const salt = parts[4];
    const key = parts[5];
    const checkKey = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(checkKey));
  }

  return false;
}
