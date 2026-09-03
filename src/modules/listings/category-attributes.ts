import { z } from 'zod';

const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size'] as const;
const BOOK_FORMATS = ['Physical', 'Digital'] as const;
const ROOM_TYPES = ['Living Room', 'Bedroom', 'Kitchen', 'Office', 'Other'] as const;

// currentYear is read inside this factory, not at module load, so the "no year beyond
// today" bound tracks the real calendar instead of freezing at whatever year the process
// happened to start in (BV-038).
function buildCategoryAttributeSchemas(): Record<string, z.ZodTypeAny> {
  const currentYear = new Date().getFullYear();

  const electronicsSchema = z.object({
    brand: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    specifications: z.string().trim().max(1000).optional(),
  });

  const vehiclesSchema = z.object({
    make: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    year: z.coerce.number().int().min(1980).max(currentYear),
    mileage: z.coerce.number().int().min(0).max(2_000_000),
  });

  const clothingSchema = z.object({
    size: z.enum(CLOTHING_SIZES),
    color: z.string().trim().min(1).max(50),
    brand: z.string().trim().max(100).optional(),
  });

  const booksSchema = z.object({
    author: z.string().trim().min(1).max(150),
    format: z.enum(BOOK_FORMATS),
    publisher: z.string().trim().max(150).optional(),
  });

  const homeSchema = z.object({
    material: z.string().trim().min(1).max(100),
    dimensions: z.string().trim().min(1).max(100),
    roomType: z.enum(ROOM_TYPES).optional(),
  });

  const sportsSchema = z.object({
    sportType: z.string().trim().min(1).max(100),
    brand: z.string().trim().max(100).optional(),
    size: z.string().trim().max(50).optional(),
  });

  const artSchema = z.object({
    creator: z.string().trim().min(1).max(150),
    medium: z.string().trim().min(1).max(150),
    yearCreated: z.coerce.number().int().min(1000).max(currentYear).optional(),
  });

  return {
    'Electronics & Gadgets': electronicsSchema,
    'Vehicles': vehiclesSchema,
    'Clothing & Fashion': clothingSchema,
    'Books & Education': booksSchema,
    'Home & Furniture': homeSchema,
    'Sports & Fitness': sportsSchema,
    'Art & Collectibles': artSchema,
  };
}

export type CategoryAttributeValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

export function validateCategoryAttributes(
  category: string,
  attributes: unknown,
): CategoryAttributeValidationResult {
  const schema = buildCategoryAttributeSchemas()[category];
  if (!schema) {
    return { success: true, data: {} };
  }

  const parsed = schema.safeParse(attributes ?? {});
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path?.join('.') || 'attributes';
    return { success: false, error: `Invalid ${field}: ${firstIssue?.message ?? 'invalid value'}` };
  }

  return { success: true, data: parsed.data as Record<string, unknown> };
}
