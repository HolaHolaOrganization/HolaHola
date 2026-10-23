/**
 * AI Bulk Drill Generator
 * 
 * Uses Gemini AI to generate large batches of high-quality drills
 * focusing on translate_speak, fill_blank, and matching types.
 * 
 * Per Daniela's recommendation:
 * - AI-powered bulk generation with quality controls
 * - Focus on translate_speak first (largest gap)
 * - Prioritize most-used paths
 */

import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { getSharedDb } from '../db';
import { 
  curriculumLessons, 
  curriculumDrillItems, 
  curriculumUnits, 
  curriculumPaths 
} from '@shared/schema';
import { eq, sql, and, like, inArray } from 'drizzle-orm';
import { callGeminiWithSchema, GEMINI_MODELS } from '../gemini-utils';

// Schema for AI-generated drills
const DRILL_GENERATION_SCHEMA = {
  type: "object",
  properties: {
    drills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The instruction or question shown to the student"
          },
          targetText: {
            type: "string",
            description: "The expected correct answer"
          },
          hints: {
            type: "array",
            items: { type: "string" },
            description: "1-2 helpful hints for the student"
          },
          difficulty: {
            type: "integer",
            description: "Difficulty level 1-4"
          }
        },
        required: ["prompt", "targetText", "hints", "difficulty"]
      }
    }
  },
  required: ["drills"]
};

interface GeneratedDrill {
  prompt: string;
  targetText: string;
  hints: string[];
  difficulty: number;
}

interface DrillGenerationResult {
  language: string;
  pathName: string;
  lessonId: string;
  drillType: string;
  count: number;
}

// Language display names
const LANGUAGE_NAMES: Record<string, string> = {
  spanish: 'Spanish',
  french: 'French',
  german: 'German',
  italian: 'Italian',
  portuguese: 'Portuguese',
  japanese: 'Japanese',
  korean: 'Korean',
  mandarin: 'Mandarin Chinese',
  english: 'English',
};

// ACTFL level mapping (more robust than string parsing)
const ACTFL_LEVELS = {
  1: { name: 'Novice Low', dbKey: 'novice_low' },
  2: { name: 'Intermediate Low', dbKey: 'intermediate_low' },
  3: { name: 'Intermediate Mid', dbKey: 'intermediate_mid' },
  4: { name: 'Intermediate High', dbKey: 'intermediate_high' },
  5: { name: 'Advanced Low', dbKey: 'advanced_low' },
} as const;

/**
 * Validate drill format before insertion
 */
function validateDrill(drill: GeneratedDrill, type: string): boolean {
  if (!drill.prompt || drill.prompt.trim().length < 3) return false;
  if (!drill.targetText || drill.targetText.trim().length < 1) return false;
  if (drill.difficulty < 1 || drill.difficulty > 4) return false;
  
  // Type-specific validation
  if (type === 'fill_blank' && !drill.prompt.includes('_____')) {
    console.log(`    Skipped fill_blank without blank: ${drill.prompt.substring(0, 30)}...`);
    return false;
  }
  
  if (type === 'matching' && !drill.targetText.includes('->')) {
    console.log(`    Skipped matching without arrow format: ${drill.targetText.substring(0, 30)}...`);
    return false;
  }
  
  return true;
}

/**
 * Extract level number from path name or description
 */
function extractLevelNumber(pathName: string): number {
  // Try to match patterns like "Spanish 1", "Level 2", "German 3"
  const matches = pathName.match(/(\d+)/);
  if (matches) {
    const num = parseInt(matches[1], 10);
    if (num >= 1 && num <= 5) return num;
  }
  return 1; // Default to novice
}

// Topics for drill generation
const TOPICS = [
  'greetings and introductions',
  'daily routines and activities',
  'travel and transportation',
  'food and dining',
  'shopping and money',
  'health and body',
  'weather and seasons',
  'family and relationships',
  'hobbies and leisure',
  'work and school',
];

/**
 * Generate translate_speak drills using AI
 */
async function generateTranslateSpeakDrills(
  language: string,
  level: string,
  topic: string,
  count: number = 20
): Promise<GeneratedDrill[]> {
  const langName = LANGUAGE_NAMES[language] || language;
  
  const prompt = `Generate ${count} translate_speak drill items for ${langName} learners at ${level} level.

Topic: ${topic}

Each drill should:
1. Present an English phrase/sentence that the student must translate and speak in ${langName}
2. Be contextually relevant to the topic
3. Progress from simpler to more complex
4. Use natural, authentic language
5. Include helpful hints

Format each drill as:
- prompt: Clear English instruction with the phrase to translate (e.g., "Say 'Hello, how are you?' in ${langName}")
- targetText: The correct ${langName} translation
- hints: 1-2 helpful hints
- difficulty: 1-4 (1=easiest, 4=hardest)

Generate practical, real-world phrases students would actually use.`;

  try {
    const result = await callGeminiWithSchema<{ drills: GeneratedDrill[] }>(
      GEMINI_MODELS.FLASH,
      [
        { role: 'user', content: prompt }
      ],
      DRILL_GENERATION_SCHEMA
    );
    
    return result.drills || [];
  } catch (error) {
    console.error(`Error generating translate_speak drills for ${language}:`, error);
    return [];
  }
}

/**
 * Generate fill_blank drills using AI
 */
async function generateFillBlankDrills(
  language: string,
  level: string,
  topic: string,
  count: number = 15
): Promise<GeneratedDrill[]> {
  const langName = LANGUAGE_NAMES[language] || language;
  
  const prompt = `Generate ${count} fill-in-the-blank drill items for ${langName} learners at ${level} level.

Topic: ${topic}

Each drill should:
1. Present a ${langName} sentence with a blank (represented as _____) 
2. The blank should test vocabulary or grammar relevant to the topic
3. Include the English translation to help context
4. Progress from simpler to more complex

Format each drill as:
- prompt: The ${langName} sentence with _____ for the blank, plus English context (e.g., "Complete: Yo _____ a la escuela (I go to school)")
- targetText: Just the missing word(s) that fills the blank
- hints: 1-2 helpful hints about the missing word
- difficulty: 1-4 (1=easiest, 4=hardest)

Focus on high-frequency vocabulary and common grammatical structures.`;

  try {
    const result = await callGeminiWithSchema<{ drills: GeneratedDrill[] }>(
      GEMINI_MODELS.FLASH,
      [
        { role: 'user', content: prompt }
      ],
      DRILL_GENERATION_SCHEMA
    );
    
    return result.drills || [];
  } catch (error) {
    console.error(`Error generating fill_blank drills for ${language}:`, error);
    return [];
  }
}

/**
 * Generate matching drills using AI
 */
async function generateMatchingDrills(
  language: string,
  level: string,
  topic: string,
  count: number = 8
): Promise<GeneratedDrill[]> {
  const langName = LANGUAGE_NAMES[language] || language;
  
  const prompt = `Generate ${count} matching drill items for ${langName} learners at ${level} level.

Topic: ${topic}

Each drill should:
1. Present a set of 4-6 items to match (English to ${langName})
2. Items should be thematically related
3. Be appropriate for the skill level

Format each drill as:
- prompt: Instructions listing the English words/phrases to match, separated by " | " (e.g., "Match these with their ${langName} translations: Hello | Goodbye | Thank you | Please")
- targetText: The correct matches in format "English -> ${langName}" separated by "; " (e.g., "Hello -> Hola; Goodbye -> Adiós; Thank you -> Gracias; Please -> Por favor")
- hints: 1-2 helpful hints
- difficulty: 1-4 (1=easiest, 4=hardest)

Use common, practical vocabulary.`;

  try {
    const result = await callGeminiWithSchema<{ drills: GeneratedDrill[] }>(
      GEMINI_MODELS.FLASH,
      [
        { role: 'user', content: prompt }
      ],
      DRILL_GENERATION_SCHEMA
    );
    
    return result.drills || [];
  } catch (error) {
    console.error(`Error generating matching drills for ${language}:`, error);
    return [];
  }
}

export async function runAIBulkDrillGeneration(): Promise<DrillGenerationResult[]> {
  const db = getSharedDb();
  const results: DrillGenerationResult[] = [];
  
  console.log('Starting AI Bulk Drill Generation...\n');
  console.log('Per Daniela: Focus on translate_speak to close production gap\n');
  
  // Get Level 1-4 paths for popular languages
  const targetLanguages = ['spanish', 'french', 'german', 'italian', 'portuguese'];
  
  const paths = await db
    .select({
      id: curriculumPaths.id,
      name: curriculumPaths.name,
      language: curriculumPaths.language,
    })
    .from(curriculumPaths)
    .where(inArray(curriculumPaths.language, targetLanguages));
  
  console.log(`Found ${paths.length} paths to enhance\n`);
  
  // Process each path
  for (const path of paths) {
    const langKey = path.language?.toLowerCase() || '';
    const levelNum = extractLevelNumber(path.name);
    const levelInfo = ACTFL_LEVELS[levelNum as keyof typeof ACTFL_LEVELS] || ACTFL_LEVELS[1];
    const level = levelInfo.name;
    
    console.log(`\nProcessing: ${path.name} (${level})`);
    
    // Get first unit
    const [unit] = await db
      .select()
      .from(curriculumUnits)
      .where(eq(curriculumUnits.curriculumPathId, path.id))
      .orderBy(curriculumUnits.orderIndex)
      .limit(1);
    
    if (!unit) {
      console.log(`  No units found, skipping`);
      continue;
    }
    
    // Check if AI drill lesson already exists
    const lessonName = `AI-Generated Practice: Active Production`;
    const existing = await db
      .select()
      .from(curriculumLessons)
      .where(
        and(
          eq(curriculumLessons.curriculumUnitId, unit.id),
          eq(curriculumLessons.name, lessonName)
        )
      );
    
    if (existing.length > 0) {
      console.log(`  AI drill lesson already exists, skipping`);
      continue;
    }
    
    // Select random topic for variety
    const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
    console.log(`  Topic: ${topic}`);
    
    // Generate drills with AI
    console.log(`  Generating translate_speak drills...`);
    const translateSpeakDrills = await generateTranslateSpeakDrills(langKey, level, topic, 25);
    
    console.log(`  Generating fill_blank drills...`);
    const fillBlankDrills = await generateFillBlankDrills(langKey, level, topic, 15);
    
    console.log(`  Generating matching drills...`);
    const matchingDrills = await generateMatchingDrills(langKey, level, topic, 8);
    
    const totalDrills = translateSpeakDrills.length + fillBlankDrills.length + matchingDrills.length;
    
    if (totalDrills === 0) {
      console.log(`  No drills generated, skipping`);
      continue;
    }
    
    // Create lesson with proper ACTFL level from mapping
    const [lesson] = await db.insert(curriculumLessons).values({
      curriculumUnitId: unit.id,
      name: lessonName,
      description: `AI-generated drills focusing on active production and vocabulary reinforcement. Topic: ${topic}.`,
      orderIndex: 55,
      lessonType: 'drill',
      actflLevel: levelInfo.dbKey as any,
      objectives: [
        'Practice active language production through translate-and-speak',
        'Reinforce vocabulary through fill-in-the-blank exercises',
        'Build recognition through matching activities',
      ],
      estimatedMinutes: 25,
      requiredTopics: [topic.split(' ')[0]],
      requirementTier: 'recommended',
    }).returning();
    
    console.log(`  Created lesson: ${lesson.id}`);
    
    // Insert all drills with validation
    let orderIndex = 1;
    const allDrillItems: any[] = [];
    let skippedCount = 0;
    
    // Add translate_speak drills (with validation)
    for (const drill of translateSpeakDrills) {
      if (!validateDrill(drill, 'translate_speak')) {
        skippedCount++;
        continue;
      }
      allDrillItems.push({
        lessonId: lesson.id,
        itemType: 'translate_speak' as const,
        orderIndex: orderIndex++,
        prompt: drill.prompt.trim(),
        targetText: drill.targetText.trim(),
        targetLanguage: langKey,
        hints: drill.hints?.filter(h => h?.trim()) || [],
        difficulty: Math.min(4, Math.max(1, drill.difficulty)),
        tags: ['translate_speak', 'ai_generated', topic.split(' ')[0]],
      });
    }
    
    // Add fill_blank drills (with validation)
    for (const drill of fillBlankDrills) {
      if (!validateDrill(drill, 'fill_blank')) {
        skippedCount++;
        continue;
      }
      allDrillItems.push({
        lessonId: lesson.id,
        itemType: 'fill_blank' as const,
        orderIndex: orderIndex++,
        prompt: drill.prompt.trim(),
        targetText: drill.targetText.trim(),
        targetLanguage: langKey,
        hints: drill.hints?.filter(h => h?.trim()) || [],
        difficulty: Math.min(4, Math.max(1, drill.difficulty)),
        tags: ['fill_blank', 'ai_generated', topic.split(' ')[0]],
      });
    }
    
    // Add matching drills (with validation)
    for (const drill of matchingDrills) {
      if (!validateDrill(drill, 'matching')) {
        skippedCount++;
        continue;
      }
      allDrillItems.push({
        lessonId: lesson.id,
        itemType: 'matching' as const,
        orderIndex: orderIndex++,
        prompt: drill.prompt.trim(),
        targetText: drill.targetText.trim(),
        targetLanguage: langKey,
        hints: drill.hints?.filter(h => h?.trim()) || [],
        difficulty: Math.min(4, Math.max(1, drill.difficulty)),
        tags: ['matching', 'ai_generated', topic.split(' ')[0]],
      });
    }
    
    if (skippedCount > 0) {
      console.log(`  Skipped ${skippedCount} invalid drills`);
    }
    
    if (allDrillItems.length > 0) {
      await db.insert(curriculumDrillItems).values(allDrillItems);
      
      console.log(`  Added ${allDrillItems.length} AI-generated drills:`);
      console.log(`    - translate_speak: ${translateSpeakDrills.length}`);
      console.log(`    - fill_blank: ${fillBlankDrills.length}`);
      console.log(`    - matching: ${matchingDrills.length}`);
      
      results.push({
        language: langKey,
        pathName: path.name,
        lessonId: lesson.id,
        drillType: 'mixed',
        count: allDrillItems.length,
      });
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return results;
}

// Run if executed directly
if (isDirectCliInvocation('ai-bulk-drill-generator.ts')) {
  runAIBulkDrillGeneration()
    .then((results) => {
      console.log('\n=== Summary ===');
      console.log(`Enhanced ${results.length} paths with AI-generated drills:`);
      
      let totalDrills = 0;
      results.forEach(r => {
        console.log(`  ${r.pathName}: ${r.count} drills`);
        totalDrills += r.count;
      });
      
      console.log(`\nTotal AI-generated drills: ${totalDrills}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err);
      process.exit(1);
    });
}
