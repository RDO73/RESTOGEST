import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';

export const catalogRouter = Router();

catalogRouter.use(requireAuth);

// -------------------------------------------------------------
// CATÉGORIES
// -------------------------------------------------------------
catalogRouter.get('/categories', async (req, res, next) => {
  try {
    const categories = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT id, name, description, created_at
         FROM public.categories
         ORDER BY name ASC`
      );
      return result.rows;
    });
    res.json({ success: true, data: categories });
  } catch (error) {
    next(error);
  }
});

catalogRouter.post('/categories', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const category = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `INSERT INTO public.categories (company_id, name, description)
         VALUES ($1, $2, $3)
         RETURNING id, name, description, created_at`,
        [req.auth!.companyId, data.name, data.description || null]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: category });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// PRODUITS
// -------------------------------------------------------------
catalogRouter.get('/products', async (req, res, next) => {
  try {
    const products = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT p.id, p.category_id, c.name as category_name, p.name, p.sku,
                p.product_type, p.unit, p.selling_price, p.cost_price,
                p.inventory_tracking, p.min_stock_alert, p.is_active,
                COALESCE(sl.current_quantity, 0) as current_stock
         FROM public.products p
         LEFT JOIN public.categories c ON c.id = p.category_id
         LEFT JOIN public.stock_levels sl ON sl.product_id = p.id
         ORDER BY p.name ASC`
      );
      return result.rows;
    });
    res.json({ success: true, data: products });
  } catch (error) {
    next(error);
  }
});

catalogRouter.post('/products', async (req, res, next) => {
  try {
    const schema = z.object({
      categoryId: z.string().uuid().optional(),
      name: z.string().min(1).max(255),
      sku: z.string().max(100).optional(),
      productType: z.enum(['raw_material', 'semi_finished', 'finished_good', 'service']).default('finished_good'),
      unit: z.string().max(20).default('unit'),
      sellingPrice: z.number().min(0).default(0),
      costPrice: z.number().min(0).default(0),
      inventoryTracking: z.enum(['direct', 'recipe_on_sale', 'none']).default('direct'),
      minStockAlert: z.number().min(0).default(0),
    });
    const data = schema.parse(req.body);

    const product = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `INSERT INTO public.products (
          company_id, category_id, name, sku, product_type, unit,
          selling_price, cost_price, inventory_tracking, min_stock_alert
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          req.auth!.companyId,
          data.categoryId || null,
          data.name,
          data.sku || null,
          data.productType,
          data.unit,
          data.sellingPrice,
          data.costPrice,
          data.inventoryTracking,
          data.minStockAlert,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// FICHES TECHNIQUES (RECETTES)
// -------------------------------------------------------------
catalogRouter.get('/recipes', async (req, res, next) => {
  try {
    const recipes = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT r.id, r.finished_product_id, p.name as product_name, r.name as recipe_name,
                r.output_quantity, r.instructions, r.is_active, r.created_at,
                json_agg(json_build_object(
                  'id', ri.id,
                  'ingredientId', ri.ingredient_id,
                  'ingredientName', ing.name,
                  'unit', ing.unit,
                  'costPrice', ing.cost_price,
                  'quantityRequired', ri.quantity_required
                )) FILTER (WHERE ri.id IS NOT NULL) as ingredients
         FROM public.recipes r
         JOIN public.products p ON p.id = r.finished_product_id
         LEFT JOIN public.recipe_ingredients ri ON ri.recipe_id = r.id
         LEFT JOIN public.products ing ON ing.id = ri.ingredient_id
         GROUP BY r.id, p.name
         ORDER BY p.name ASC`
      );
      return result.rows;
    });
    res.json({ success: true, data: recipes });
  } catch (error) {
    next(error);
  }
});

catalogRouter.post('/recipes', async (req, res, next) => {
  try {
    const schema = z.object({
      finishedProductId: z.string().uuid(),
      name: z.string().min(1).max(255),
      outputQuantity: z.number().positive().default(1),
      instructions: z.string().optional(),
      ingredients: z.array(
        z.object({
          ingredientId: z.string().uuid(),
          quantityRequired: z.number().positive(),
        })
      ).min(1),
    });
    const data = schema.parse(req.body);

    const recipe = await withTenantContext(req.auth!, async (client) => {
      // 1. Création de la recette
      const recRes = await client.query(
        `INSERT INTO public.recipes (company_id, finished_product_id, name, output_quantity, instructions)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.auth!.companyId, data.finishedProductId, data.name, data.outputQuantity, data.instructions || null]
      );
      const createdRecipe = recRes.rows[0];

      // 2. Insertion des ingrédients (sécurisé par le trigger anti-cycle trg_recipe_ingredients_cycle)
      for (const ing of data.ingredients) {
        await client.query(
          `INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
           VALUES ($1, $2, $3, $4)`,
          [req.auth!.companyId, createdRecipe.id, ing.ingredientId, ing.quantityRequired]
        );
      }

      return createdRecipe;
    });

    res.status(201).json({ success: true, data: recipe });
  } catch (error) {
    next(error);
  }
});
