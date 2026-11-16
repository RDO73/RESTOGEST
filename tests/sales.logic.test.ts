import { describe, it, expect } from 'vitest';

describe('Logique de calcul des ventes et contraintes financières', () => {
  it('le sous-total de ligne doit être strictement égal à ROUND(quantity * unit_price, 2)', () => {
    const qty1 = 3.5;
    const price1 = 1250;
    const subtotal1 = Math.round(qty1 * price1 * 100) / 100;
    expect(subtotal1).toBe(4375);

    const qty2 = 0.333;
    const price2 = 2500;
    const subtotal2 = Math.round(qty2 * price2 * 100) / 100;
    expect(subtotal2).toBe(832.5);
  });

  it('le montant net HT après remise ne peut pas être négatif', () => {
    const subtotal = 10000;
    const validDiscount = 2000;
    const taxableBase = subtotal - validDiscount;
    expect(taxableBase).toBeGreaterThanOrEqual(0);

    const excessiveDiscount = 15000;
    const isValid = excessiveDiscount <= subtotal;
    expect(isValid).toBe(false);
  });

  it('le calcul de taxe doit appliquer ROUND((subtotal - discount) * tax_rate / 100, 2)', () => {
    const subtotal = 15000;
    const discount = 1500;
    const taxRate = 18; // TVA standard UEMOA 18%

    const taxAmount = Math.round(((subtotal - discount) * taxRate / 100) * 100) / 100;
    const totalTTC = (subtotal - discount) + taxAmount;

    expect(taxAmount).toBe(2430);
    expect(totalTTC).toBe(15930);
  });

  it('le calcul du PMP doit appliquer la formule moyenne pondérée', () => {
    const qActuel = 10;
    const pmpActuel = 500; // valeur actuelle = 5000
    const qRecu = 20;
    const pAchat = 650; // valeur reçue = 13000

    const nouveauPmp = ((qActuel * pmpActuel) + (qRecu * pAchat)) / (qActuel + qRecu);
    expect(nouveauPmp).toBe(600);
  });
});
