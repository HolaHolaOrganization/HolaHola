/**
 * Boost Drill Variety Script
 * 
 * Generates translate_speak, fill_blank, and matching drills
 * to increase drill type diversity across all language levels.
 * 
 * Current distribution issues:
 * - translate_speak: 11.47% (target: 20-25%)
 * - fill_blank: 0.82% (target: 5-8%)
 * - matching: 0.05% (target: 3-5%)
 * 
 * Strategy: Create new drills from existing vocabulary patterns
 */

import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { getSharedDb } from '../db';
import { curriculumLessons, curriculumDrillItems, curriculumUnits, curriculumPaths } from '@shared/schema';
import { eq, sql, and, like, notLike } from 'drizzle-orm';

// Common phrases and vocabulary by topic and language for drill generation
const VOCABULARY_TEMPLATES: Record<string, Record<string, { native: string; target: string; context: string }[]>> = {
  greetings: {
    spanish: [
      { native: 'Hello', target: 'Hola', context: 'greeting someone' },
      { native: 'Good morning', target: 'Buenos días', context: 'morning greeting' },
      { native: 'Good afternoon', target: 'Buenas tardes', context: 'afternoon greeting' },
      { native: 'Good evening', target: 'Buenas noches', context: 'evening greeting' },
      { native: 'How are you?', target: '¿Cómo estás?', context: 'asking about wellbeing' },
      { native: 'Nice to meet you', target: 'Mucho gusto', context: 'meeting someone new' },
      { native: 'See you later', target: 'Hasta luego', context: 'saying goodbye' },
      { native: 'Goodbye', target: 'Adiós', context: 'final farewell' },
    ],
    french: [
      { native: 'Hello', target: 'Bonjour', context: 'greeting someone' },
      { native: 'Good evening', target: 'Bonsoir', context: 'evening greeting' },
      { native: 'How are you?', target: 'Comment allez-vous?', context: 'formal wellbeing' },
      { native: 'Nice to meet you', target: 'Enchanté', context: 'meeting someone new' },
      { native: 'See you later', target: 'À bientôt', context: 'saying goodbye' },
      { native: 'Goodbye', target: 'Au revoir', context: 'final farewell' },
    ],
    german: [
      { native: 'Hello', target: 'Hallo', context: 'greeting someone' },
      { native: 'Good morning', target: 'Guten Morgen', context: 'morning greeting' },
      { native: 'Good day', target: 'Guten Tag', context: 'daytime greeting' },
      { native: 'Good evening', target: 'Guten Abend', context: 'evening greeting' },
      { native: 'How are you?', target: 'Wie geht es Ihnen?', context: 'asking about wellbeing' },
      { native: 'Goodbye', target: 'Auf Wiedersehen', context: 'formal farewell' },
    ],
    italian: [
      { native: 'Hello', target: 'Ciao', context: 'informal greeting' },
      { native: 'Good morning', target: 'Buongiorno', context: 'morning greeting' },
      { native: 'Good evening', target: 'Buonasera', context: 'evening greeting' },
      { native: 'How are you?', target: 'Come stai?', context: 'asking about wellbeing' },
      { native: 'Goodbye', target: 'Arrivederci', context: 'formal farewell' },
    ],
    portuguese: [
      { native: 'Hello', target: 'Olá', context: 'greeting someone' },
      { native: 'Good morning', target: 'Bom dia', context: 'morning greeting' },
      { native: 'Good afternoon', target: 'Boa tarde', context: 'afternoon greeting' },
      { native: 'Good evening', target: 'Boa noite', context: 'evening greeting' },
      { native: 'How are you?', target: 'Como vai?', context: 'asking about wellbeing' },
    ],
  },
  travel: {
    spanish: [
      { native: 'Where is the hotel?', target: '¿Dónde está el hotel?', context: 'asking for directions' },
      { native: 'I need a taxi', target: 'Necesito un taxi', context: 'transportation' },
      { native: 'How much does it cost?', target: '¿Cuánto cuesta?', context: 'asking price' },
      { native: 'The train station', target: 'La estación de tren', context: 'transportation hub' },
      { native: 'I have a reservation', target: 'Tengo una reservación', context: 'hotel check-in' },
      { native: 'The airport', target: 'El aeropuerto', context: 'travel location' },
    ],
    french: [
      { native: 'Where is the hotel?', target: 'Où est l\'hôtel?', context: 'asking for directions' },
      { native: 'I need a taxi', target: 'J\'ai besoin d\'un taxi', context: 'transportation' },
      { native: 'How much does it cost?', target: 'Combien ça coûte?', context: 'asking price' },
      { native: 'The train station', target: 'La gare', context: 'transportation hub' },
      { native: 'I have a reservation', target: 'J\'ai une réservation', context: 'hotel check-in' },
    ],
    german: [
      { native: 'Where is the hotel?', target: 'Wo ist das Hotel?', context: 'asking for directions' },
      { native: 'I need a taxi', target: 'Ich brauche ein Taxi', context: 'transportation' },
      { native: 'How much does it cost?', target: 'Wie viel kostet das?', context: 'asking price' },
      { native: 'The train station', target: 'Der Bahnhof', context: 'transportation hub' },
    ],
    italian: [
      { native: 'Where is the hotel?', target: 'Dov\'è l\'hotel?', context: 'asking for directions' },
      { native: 'I need a taxi', target: 'Ho bisogno di un taxi', context: 'transportation' },
      { native: 'How much does it cost?', target: 'Quanto costa?', context: 'asking price' },
      { native: 'The train station', target: 'La stazione', context: 'transportation hub' },
    ],
    portuguese: [
      { native: 'Where is the hotel?', target: 'Onde fica o hotel?', context: 'asking for directions' },
      { native: 'I need a taxi', target: 'Preciso de um táxi', context: 'transportation' },
      { native: 'How much does it cost?', target: 'Quanto custa?', context: 'asking price' },
    ],
  },
  daily_routines: {
    spanish: [
      { native: 'I wake up at seven', target: 'Me despierto a las siete', context: 'morning routine' },
      { native: 'I eat breakfast', target: 'Desayuno', context: 'morning meal' },
      { native: 'I go to work', target: 'Voy al trabajo', context: 'commuting' },
      { native: 'I have lunch', target: 'Almuerzo', context: 'midday meal' },
      { native: 'I go to sleep', target: 'Me acuesto', context: 'bedtime routine' },
    ],
    french: [
      { native: 'I wake up at seven', target: 'Je me réveille à sept heures', context: 'morning routine' },
      { native: 'I eat breakfast', target: 'Je prends le petit-déjeuner', context: 'morning meal' },
      { native: 'I go to work', target: 'Je vais au travail', context: 'commuting' },
      { native: 'I have lunch', target: 'Je déjeune', context: 'midday meal' },
    ],
    german: [
      { native: 'I wake up at seven', target: 'Ich wache um sieben Uhr auf', context: 'morning routine' },
      { native: 'I eat breakfast', target: 'Ich frühstücke', context: 'morning meal' },
      { native: 'I go to work', target: 'Ich gehe zur Arbeit', context: 'commuting' },
    ],
    italian: [
      { native: 'I wake up at seven', target: 'Mi sveglio alle sette', context: 'morning routine' },
      { native: 'I eat breakfast', target: 'Faccio colazione', context: 'morning meal' },
      { native: 'I go to work', target: 'Vado al lavoro', context: 'commuting' },
    ],
    portuguese: [
      { native: 'I wake up at seven', target: 'Eu acordo às sete', context: 'morning routine' },
      { native: 'I eat breakfast', target: 'Eu tomo café da manhã', context: 'morning meal' },
      { native: 'I go to work', target: 'Eu vou trabalhar', context: 'commuting' },
    ],
  },
};

// Map language names to target language codes
const LANGUAGE_CODES: Record<string, string> = {
  spanish: 'spanish',
  french: 'french',
  german: 'german',
  italian: 'italian',
  portuguese: 'portuguese',
  japanese: 'japanese',
  korean: 'korean',
  mandarin: 'mandarin',
  english: 'english',
};

interface DrillGenerationResult {
  language: string;
  pathName: string;
  lessonId: string;
  translateSpeakCount: number;
  fillBlankCount: number;
  matchingCount: number;
}

/**
 * Generate translate_speak drills from vocabulary
 */
function generateTranslateSpeakDrills(
  vocabulary: { native: string; target: string; context: string }[],
  language: string,
  lessonId: string,
  startIndex: number
): any[] {
  return vocabulary.map((vocab, idx) => ({
    lessonId,
    itemType: 'translate_speak' as const,
    orderIndex: startIndex + idx,
    prompt: `Say "${vocab.native}" in ${language}. Context: ${vocab.context}`,
    targetText: vocab.target,
    targetLanguage: language,
    hints: [`Think about ${vocab.context}`, `The answer starts with: ${vocab.target.charAt(0)}...`],
    difficulty: 2,
    tags: ['translate_speak', 'active_production', vocab.context.split(' ')[0]],
  }));
}

/**
 * Generate fill_blank drills from vocabulary
 */
function generateFillBlankDrills(
  vocabulary: { native: string; target: string; context: string }[],
  language: string,
  lessonId: string,
  startIndex: number
): any[] {
  return vocabulary.slice(0, Math.min(vocabulary.length, 5)).map((vocab, idx) => {
    // Create a blank by removing a key word
    const words = vocab.target.split(' ');
    if (words.length > 1) {
      const blankIndex = Math.floor(words.length / 2);
      const blankedWord = words[blankIndex];
      words[blankIndex] = '_____';
      const promptWithBlank = words.join(' ');
      
      return {
        lessonId,
        itemType: 'fill_blank' as const,
        orderIndex: startIndex + idx,
        prompt: `Complete the phrase: "${promptWithBlank}" (English: ${vocab.native})`,
        targetText: blankedWord,
        targetLanguage: language,
        hints: [`The missing word means part of "${vocab.native}"`, `Context: ${vocab.context}`],
        difficulty: 2,
        tags: ['fill_blank', 'vocabulary', vocab.context.split(' ')[0]],
      };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Generate matching drills from vocabulary
 */
function generateMatchingDrills(
  vocabulary: { native: string; target: string; context: string }[],
  language: string,
  lessonId: string,
  startIndex: number
): any[] {
  // Create matching pairs from vocabulary
  const pairs = vocabulary.slice(0, Math.min(vocabulary.length, 4));
  
  if (pairs.length < 2) return [];
  
  const nativeList = pairs.map(p => p.native).join(' | ');
  const targetList = pairs.map(p => p.target).join(' | ');
  
  return [{
    lessonId,
    itemType: 'matching' as const,
    orderIndex: startIndex,
    prompt: `Match the English phrases with their ${language} translations:\n\nEnglish: ${nativeList}\n\n${language}: ${targetList}`,
    targetText: pairs.map(p => `${p.native} → ${p.target}`).join('; '),
    targetLanguage: language,
    hints: ['Match each English phrase to its translation', `Look for cognates or familiar words`],
    difficulty: 1,
    tags: ['matching', 'vocabulary', 'recognition'],
  }];
}

export async function boostDrillVariety(): Promise<DrillGenerationResult[]> {
  const db = getSharedDb();
  const results: DrillGenerationResult[] = [];
  
  console.log('Starting drill variety boost...\n');
  
  // Get all Level 2-5 paths (where drill variety is most needed)
  const paths = await db
    .select({
      id: curriculumPaths.id,
      name: curriculumPaths.name,
      language: curriculumPaths.language,
    })
    .from(curriculumPaths)
    .where(
      sql`${curriculumPaths.name} LIKE '%2%' OR ${curriculumPaths.name} LIKE '%3%' OR ${curriculumPaths.name} LIKE '%4%' OR ${curriculumPaths.name} LIKE '%5%'`
    );
  
  console.log(`Found ${paths.length} Level 2 paths to enhance\n`);
  
  for (const path of paths) {
    const langKey = path.language?.toLowerCase() || '';
    
    // Skip languages we don't have templates for
    if (!['spanish', 'french', 'german', 'italian', 'portuguese'].includes(langKey)) {
      console.log(`Skipping ${path.name} - no templates for ${langKey}`);
      continue;
    }
    
    console.log(`Processing: ${path.name}`);
    
    // Get first unit of this path
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
    
    // Create a new drill lesson for variety practice
    const lessonName = `Active Practice: Mixed Drills`;
    const lessonDescription = `Practice speaking, fill-in-the-blank, and matching exercises to reinforce vocabulary and phrases.`;
    
    // Check if lesson already exists
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
      console.log(`  Lesson already exists, skipping`);
      continue;
    }
    
    // Create the lesson
    const [lesson] = await db.insert(curriculumLessons).values({
      curriculumUnitId: unit.id,
      name: lessonName,
      description: lessonDescription,
      orderIndex: 50, // Middle of unit
      lessonType: 'drill',
      actflLevel: 'intermediate_low',
      objectives: [
        'Practice active production through translate-and-speak exercises',
        'Reinforce vocabulary through fill-in-the-blank activities',
        'Build recognition through matching exercises',
      ],
      estimatedMinutes: 20,
      requiredTopics: ['vocabulary', 'phrases'],
      requirementTier: 'recommended',
    }).returning();
    
    console.log(`  Created lesson: ${lesson.id}`);
    
    // Generate drills from multiple topics
    const allDrills: any[] = [];
    let orderIndex = 1;
    
    for (const topic of ['greetings', 'travel', 'daily_routines']) {
      const vocabulary = VOCABULARY_TEMPLATES[topic]?.[langKey];
      if (!vocabulary || vocabulary.length === 0) continue;
      
      // Generate translate_speak drills
      const translateSpeakDrills = generateTranslateSpeakDrills(
        vocabulary,
        langKey,
        lesson.id,
        orderIndex
      );
      allDrills.push(...translateSpeakDrills);
      orderIndex += translateSpeakDrills.length;
      
      // Generate fill_blank drills
      const fillBlankDrills = generateFillBlankDrills(
        vocabulary,
        langKey,
        lesson.id,
        orderIndex
      );
      allDrills.push(...fillBlankDrills);
      orderIndex += fillBlankDrills.length;
      
      // Generate matching drills
      const matchingDrills = generateMatchingDrills(
        vocabulary,
        langKey,
        lesson.id,
        orderIndex
      );
      allDrills.push(...matchingDrills);
      orderIndex += matchingDrills.length;
    }
    
    if (allDrills.length > 0) {
      await db.insert(curriculumDrillItems).values(allDrills);
      
      const translateSpeakCount = allDrills.filter(d => d.itemType === 'translate_speak').length;
      const fillBlankCount = allDrills.filter(d => d.itemType === 'fill_blank').length;
      const matchingCount = allDrills.filter(d => d.itemType === 'matching').length;
      
      console.log(`  Added ${allDrills.length} drills:`);
      console.log(`    - translate_speak: ${translateSpeakCount}`);
      console.log(`    - fill_blank: ${fillBlankCount}`);
      console.log(`    - matching: ${matchingCount}`);
      
      results.push({
        language: langKey,
        pathName: path.name,
        lessonId: lesson.id,
        translateSpeakCount,
        fillBlankCount,
        matchingCount,
      });
    }
  }
  
  return results;
}

// Run if executed directly
if (isDirectCliInvocation('boost-drill-variety.ts')) {
  boostDrillVariety()
    .then((results) => {
      console.log('\n=== Summary ===');
      console.log(`Enhanced ${results.length} paths with varied drills:`);
      
      let totalTranslateSpeak = 0;
      let totalFillBlank = 0;
      let totalMatching = 0;
      
      results.forEach(r => {
        console.log(`  ${r.pathName}:`);
        console.log(`    translate_speak: ${r.translateSpeakCount}`);
        console.log(`    fill_blank: ${r.fillBlankCount}`);
        console.log(`    matching: ${r.matchingCount}`);
        totalTranslateSpeak += r.translateSpeakCount;
        totalFillBlank += r.fillBlankCount;
        totalMatching += r.matchingCount;
      });
      
      console.log(`\nTotal drills added:`);
      console.log(`  translate_speak: ${totalTranslateSpeak}`);
      console.log(`  fill_blank: ${totalFillBlank}`);
      console.log(`  matching: ${totalMatching}`);
      
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err);
      process.exit(1);
    });
}
