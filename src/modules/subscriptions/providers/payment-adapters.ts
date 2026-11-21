import crypto from 'node:crypto';

export interface ProviderInitiationInput {
  transactionRef: string;
  countryCode: string;
  currency: string;
  grossAmount: number;
  methodCode: string;
  payerPhone?: string | null;
  customerEmail?: string | null;
  manualReference?: string | null;
}

export interface ProviderInitiationResult {
  providerCode: string;
  requiresManualVerification: boolean;
  initialStatus: 'pending' | 'initiated';
  instructions: string;
  checkoutUrl: string | null;
  isLiveConfigured: boolean;
}

export interface PaymentProviderAdapter {
  code: string;
  name: string;
  isConfigured(): boolean;
  initiatePayment(input: ProviderInitiationInput): ProviderInitiationResult;
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>, fallbackSecret: string): boolean;
}

function timingSafeCompareHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyDefaultHmac(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): boolean {
  const sig = String(headers['x-saas-signature'] || '').trim();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeCompareHex(sig, expected);
}

export const PAYMENT_PROVIDER_ADAPTERS: Record<string, PaymentProviderAdapter> = {
  manual_wave_sn: {
    code: 'manual_wave_sn',
    name: 'Wave Sénégal (Vérification Manuelle)',
    isConfigured: () => true,
    initiatePayment: (input) => ({
      providerCode: 'manual_wave_sn',
      requiresManualVerification: true,
      initialStatus: 'pending',
      instructions: `Envoyez ${input.grossAmount} ${input.currency} sur le compte Wave Marchand +221 78 897 93 42 puis transmettez votre référence. Activation après contrôle réel par le Super-Administrateur.`,
      checkoutUrl: null,
      isLiveConfigured: true,
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) =>
      verifyDefaultHmac(rawBody, headers, fallbackSecret),
  },

  bank_transfer: {
    code: 'bank_transfer',
    name: 'Virement Bancaire / Dépôt avec Preuve',
    isConfigured: () => true,
    initiatePayment: (input) => ({
      providerCode: 'bank_transfer',
      requiresManualVerification: true,
      initialStatus: 'pending',
      instructions: `Effectuez un virement de ${input.grossAmount} ${input.currency} en indiquant la référence ${input.transactionRef}. Validation après contrôle du relevé bancaire.`,
      checkoutUrl: null,
      isLiveConfigured: true,
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) =>
      verifyDefaultHmac(rawBody, headers, fallbackSecret),
  },

  paydunya: {
    code: 'paydunya',
    name: 'PayDunya Checkout (UEMOA)',
    isConfigured: () => Boolean(process.env.PAYDUNYA_MASTER_KEY && process.env.PAYDUNYA_PRIVATE_KEY),
    initiatePayment: (input) => ({
      providerCode: 'paydunya',
      requiresManualVerification: !Boolean(process.env.PAYDUNYA_MASTER_KEY && process.env.PAYDUNYA_PRIVATE_KEY),
      initialStatus: 'pending',
      instructions: process.env.PAYDUNYA_PRIVATE_KEY
        ? `Session PayDunya initialisée pour ${input.grossAmount} ${input.currency}.`
        : 'PayDunya en attente de clés API (PAYDUNYA_MASTER_KEY / PAYDUNYA_PRIVATE_KEY) — paiement enregistré en attente de vérification.',
      checkoutUrl: null,
      isLiveConfigured: Boolean(process.env.PAYDUNYA_MASTER_KEY && process.env.PAYDUNYA_PRIVATE_KEY),
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) => {
      if (process.env.PAYDUNYA_MASTER_KEY && headers['paydunya-signature']) {
        const expected = crypto.createHmac('sha256', process.env.PAYDUNYA_MASTER_KEY).update(rawBody).digest('hex');
        return timingSafeCompareHex(String(headers['paydunya-signature']), expected);
      }
      return verifyDefaultHmac(rawBody, headers, fallbackSecret);
    },
  },

  paytech: {
    code: 'paytech',
    name: 'PayTech Sénégal',
    isConfigured: () => Boolean(process.env.PAYTECH_API_KEY && process.env.PAYTECH_API_SECRET),
    initiatePayment: (input) => ({
      providerCode: 'paytech',
      requiresManualVerification: !Boolean(process.env.PAYTECH_API_KEY && process.env.PAYTECH_API_SECRET),
      initialStatus: 'pending',
      instructions: process.env.PAYTECH_API_KEY
        ? `Session PayTech initialisée pour ${input.grossAmount} ${input.currency}.`
        : 'PayTech nécessite PAYTECH_API_KEY et PAYTECH_API_SECRET.',
      checkoutUrl: null,
      isLiveConfigured: Boolean(process.env.PAYTECH_API_KEY && process.env.PAYTECH_API_SECRET),
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) => {
      const secret = process.env.PAYTECH_API_SECRET || fallbackSecret;
      return verifyDefaultHmac(rawBody, headers, secret);
    },
  },

  cinetpay: {
    code: 'cinetpay',
    name: 'CinetPay Afrique',
    isConfigured: () => Boolean(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID),
    initiatePayment: (input) => ({
      providerCode: 'cinetpay',
      requiresManualVerification: !Boolean(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID),
      initialStatus: 'pending',
      instructions: process.env.CINETPAY_API_KEY
        ? `Session CinetPay initialisée pour ${input.grossAmount} ${input.currency}.`
        : 'CinetPay en attente de clés API (CINETPAY_API_KEY / CINETPAY_SITE_ID) — vérification manuelle requise.',
      checkoutUrl: null,
      isLiveConfigured: Boolean(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID),
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) => {
      if (process.env.CINETPAY_SECRET_KEY && headers['x-token']) {
        const expected = crypto.createHmac('sha256', process.env.CINETPAY_SECRET_KEY).update(rawBody).digest('hex');
        return timingSafeCompareHex(String(headers['x-token']), expected);
      }
      return verifyDefaultHmac(rawBody, headers, fallbackSecret);
    },
  },

  flutterwave: {
    code: 'flutterwave',
    name: 'Flutterwave Africa',
    isConfigured: () => Boolean(process.env.FLW_SECRET_KEY),
    initiatePayment: (input) => ({
      providerCode: 'flutterwave',
      requiresManualVerification: !Boolean(process.env.FLW_SECRET_KEY),
      initialStatus: 'pending',
      instructions: process.env.FLW_SECRET_KEY
        ? `Session Flutterwave initialisée pour ${input.grossAmount} ${input.currency}.`
        : 'Flutterwave nécessite FLW_SECRET_KEY.',
      checkoutUrl: null,
      isLiveConfigured: Boolean(process.env.FLW_SECRET_KEY),
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) => {
      if (process.env.FLW_WEBHOOK_HASH && headers['verif-hash']) {
        const expectedHash = crypto.createHash('sha256').update(process.env.FLW_WEBHOOK_HASH).digest();
        const receivedHash = crypto.createHash('sha256').update(String(headers['verif-hash'])).digest();
        return crypto.timingSafeEqual(expectedHash, receivedHash);
      }
      return verifyDefaultHmac(rawBody, headers, fallbackSecret);
    },
  },

  paystack: {
    code: 'paystack',
    name: 'Paystack',
    isConfigured: () => Boolean(process.env.PAYSTACK_SECRET_KEY),
    initiatePayment: (input) => ({
      providerCode: 'paystack',
      requiresManualVerification: !Boolean(process.env.PAYSTACK_SECRET_KEY),
      initialStatus: 'pending',
      instructions: process.env.PAYSTACK_SECRET_KEY
        ? `Session Paystack initialisée pour ${input.grossAmount} ${input.currency}.`
        : 'Paystack nécessite PAYSTACK_SECRET_KEY.',
      checkoutUrl: null,
      isLiveConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY),
    }),
    verifyWebhookSignature: (rawBody, headers, fallbackSecret) => {
      if (process.env.PAYSTACK_SECRET_KEY && headers['x-paystack-signature']) {
        const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
        return timingSafeCompareHex(String(headers['x-paystack-signature']), expected);
      }
      return verifyDefaultHmac(rawBody, headers, fallbackSecret);
    },
  },
};

export function getPaymentProviderAdapter(providerCode: string): PaymentProviderAdapter {
  const key = String(providerCode || '').toLowerCase();
  return PAYMENT_PROVIDER_ADAPTERS[key] || PAYMENT_PROVIDER_ADAPTERS.bank_transfer;
}
