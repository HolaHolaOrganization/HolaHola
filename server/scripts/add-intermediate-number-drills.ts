/**
 * Script to add intermediate-level number drills across all 9 languages
 * 
 * Priority 1 from Daniela's drill audit:
 * - Build number_dictation drills for Intermediate levels
 * - Currently 99%+ are at novice_low only
 * - Add real-world numbers: years, phone numbers, prices, larger numbers
 */

import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { getSharedDb } from '../db';
import { curriculumLessons, curriculumDrillItems } from '@shared/schema';
import { sql } from 'drizzle-orm';

// Number words by language for intermediate level (21-100, hundreds, years)
const NUMBER_WORDS: Record<string, Record<string, string>> = {
  english: {
    // Tens and combinations (21-99)
    '21': 'twenty-one', '25': 'twenty-five', '30': 'thirty', '33': 'thirty-three',
    '40': 'forty', '44': 'forty-four', '50': 'fifty', '55': 'fifty-five',
    '60': 'sixty', '66': 'sixty-six', '70': 'seventy', '77': 'seventy-seven',
    '80': 'eighty', '88': 'eighty-eight', '90': 'ninety', '99': 'ninety-nine',
    // Hundreds
    '100': 'one hundred', '200': 'two hundred', '250': 'two hundred fifty',
    '300': 'three hundred', '500': 'five hundred', '750': 'seven hundred fifty',
    // Years
    '1990': 'nineteen ninety', '1999': 'nineteen ninety-nine', '2000': 'two thousand',
    '2010': 'twenty ten', '2024': 'twenty twenty-four', '2025': 'twenty twenty-five',
    // Thousands
    '1000': 'one thousand', '2500': 'two thousand five hundred', '5000': 'five thousand',
  },
  spanish: {
    '21': 'veintiuno', '25': 'veinticinco', '30': 'treinta', '33': 'treinta y tres',
    '40': 'cuarenta', '44': 'cuarenta y cuatro', '50': 'cincuenta', '55': 'cincuenta y cinco',
    '60': 'sesenta', '66': 'sesenta y seis', '70': 'setenta', '77': 'setenta y siete',
    '80': 'ochenta', '88': 'ochenta y ocho', '90': 'noventa', '99': 'noventa y nueve',
    '100': 'cien', '200': 'doscientos', '250': 'doscientos cincuenta',
    '300': 'trescientos', '500': 'quinientos', '750': 'setecientos cincuenta',
    '1990': 'mil novecientos noventa', '1999': 'mil novecientos noventa y nueve', 
    '2000': 'dos mil', '2010': 'dos mil diez', '2024': 'dos mil veinticuatro', '2025': 'dos mil veinticinco',
    '1000': 'mil', '2500': 'dos mil quinientos', '5000': 'cinco mil',
  },
  french: {
    '21': 'vingt et un', '25': 'vingt-cinq', '30': 'trente', '33': 'trente-trois',
    '40': 'quarante', '44': 'quarante-quatre', '50': 'cinquante', '55': 'cinquante-cinq',
    '60': 'soixante', '66': 'soixante-six', '70': 'soixante-dix', '77': 'soixante-dix-sept',
    '80': 'quatre-vingts', '88': 'quatre-vingt-huit', '90': 'quatre-vingt-dix', '99': 'quatre-vingt-dix-neuf',
    '100': 'cent', '200': 'deux cents', '250': 'deux cent cinquante',
    '300': 'trois cents', '500': 'cinq cents', '750': 'sept cent cinquante',
    '1990': 'mille neuf cent quatre-vingt-dix', '1999': 'mille neuf cent quatre-vingt-dix-neuf',
    '2000': 'deux mille', '2010': 'deux mille dix', '2024': 'deux mille vingt-quatre', '2025': 'deux mille vingt-cinq',
    '1000': 'mille', '2500': 'deux mille cinq cents', '5000': 'cinq mille',
  },
  german: {
    '21': 'einundzwanzig', '25': 'fünfundzwanzig', '30': 'dreißig', '33': 'dreiunddreißig',
    '40': 'vierzig', '44': 'vierundvierzig', '50': 'fünfzig', '55': 'fünfundfünfzig',
    '60': 'sechzig', '66': 'sechsundsechzig', '70': 'siebzig', '77': 'siebenundsiebzig',
    '80': 'achtzig', '88': 'achtundachtzig', '90': 'neunzig', '99': 'neunundneunzig',
    '100': 'einhundert', '200': 'zweihundert', '250': 'zweihundertfünfzig',
    '300': 'dreihundert', '500': 'fünfhundert', '750': 'siebenhundertfünfzig',
    '1990': 'neunzehnhundertneunzig', '1999': 'neunzehnhundertneunundneunzig',
    '2000': 'zweitausend', '2010': 'zweitausendzehn', '2024': 'zweitausendvierundzwanzig', '2025': 'zweitausendfünfundzwanzig',
    '1000': 'eintausend', '2500': 'zweitausendfünfhundert', '5000': 'fünftausend',
  },
  italian: {
    '21': 'ventuno', '25': 'venticinque', '30': 'trenta', '33': 'trentatré',
    '40': 'quaranta', '44': 'quarantaquattro', '50': 'cinquanta', '55': 'cinquantacinque',
    '60': 'sessanta', '66': 'sessantasei', '70': 'settanta', '77': 'settantasette',
    '80': 'ottanta', '88': 'ottantotto', '90': 'novanta', '99': 'novantanove',
    '100': 'cento', '200': 'duecento', '250': 'duecentocinquanta',
    '300': 'trecento', '500': 'cinquecento', '750': 'settecentocinquanta',
    '1990': 'millenovecentonovanta', '1999': 'millenovecentonovantanove',
    '2000': 'duemila', '2010': 'duemiladieci', '2024': 'duemilaventiquattro', '2025': 'duemilaventicinque',
    '1000': 'mille', '2500': 'duemilacinquecento', '5000': 'cinquemila',
  },
  portuguese: {
    '21': 'vinte e um', '25': 'vinte e cinco', '30': 'trinta', '33': 'trinta e três',
    '40': 'quarenta', '44': 'quarenta e quatro', '50': 'cinquenta', '55': 'cinquenta e cinco',
    '60': 'sessenta', '66': 'sessenta e seis', '70': 'setenta', '77': 'setenta e sete',
    '80': 'oitenta', '88': 'oitenta e oito', '90': 'noventa', '99': 'noventa e nove',
    '100': 'cem', '200': 'duzentos', '250': 'duzentos e cinquenta',
    '300': 'trezentos', '500': 'quinhentos', '750': 'setecentos e cinquenta',
    '1990': 'mil novecentos e noventa', '1999': 'mil novecentos e noventa e nove',
    '2000': 'dois mil', '2010': 'dois mil e dez', '2024': 'dois mil e vinte e quatro', '2025': 'dois mil e vinte e cinco',
    '1000': 'mil', '2500': 'dois mil e quinhentos', '5000': 'cinco mil',
  },
  japanese: {
    '21': 'にじゅういち', '25': 'にじゅうご', '30': 'さんじゅう', '33': 'さんじゅうさん',
    '40': 'よんじゅう', '44': 'よんじゅうよん', '50': 'ごじゅう', '55': 'ごじゅうご',
    '60': 'ろくじゅう', '66': 'ろくじゅうろく', '70': 'ななじゅう', '77': 'ななじゅうなな',
    '80': 'はちじゅう', '88': 'はちじゅうはち', '90': 'きゅうじゅう', '99': 'きゅうじゅうきゅう',
    '100': 'ひゃく', '200': 'にひゃく', '250': 'にひゃくごじゅう',
    '300': 'さんびゃく', '500': 'ごひゃく', '750': 'ななひゃくごじゅう',
    '1990': 'せんきゅうひゃくきゅうじゅう', '1999': 'せんきゅうひゃくきゅうじゅうきゅう',
    '2000': 'にせん', '2010': 'にせんじゅう', '2024': 'にせんにじゅうよん', '2025': 'にせんにじゅうご',
    '1000': 'せん', '2500': 'にせんごひゃく', '5000': 'ごせん',
  },
  korean: {
    '21': '이십일', '25': '이십오', '30': '삼십', '33': '삼십삼',
    '40': '사십', '44': '사십사', '50': '오십', '55': '오십오',
    '60': '육십', '66': '육십육', '70': '칠십', '77': '칠십칠',
    '80': '팔십', '88': '팔십팔', '90': '구십', '99': '구십구',
    '100': '백', '200': '이백', '250': '이백오십',
    '300': '삼백', '500': '오백', '750': '칠백오십',
    '1990': '천구백구십', '1999': '천구백구십구',
    '2000': '이천', '2010': '이천십', '2024': '이천이십사', '2025': '이천이십오',
    '1000': '천', '2500': '이천오백', '5000': '오천',
  },
  mandarin: {
    '21': '二十一', '25': '二十五', '30': '三十', '33': '三十三',
    '40': '四十', '44': '四十四', '50': '五十', '55': '五十五',
    '60': '六十', '66': '六十六', '70': '七十', '77': '七十七',
    '80': '八十', '88': '八十八', '90': '九十', '99': '九十九',
    '100': '一百', '200': '二百', '250': '二百五十',
    '300': '三百', '500': '五百', '750': '七百五十',
    '1990': '一九九零', '1999': '一九九九',
    '2000': '二千', '2010': '二零一零', '2024': '二零二四', '2025': '二零二五',
    '1000': '一千', '2500': '二千五百', '5000': '五千',
  },
};

// Target units for each language (Travel units work well for number context)
const TARGET_UNITS: Record<string, string> = {
  english: 'e95d9e43-0400-43f6-95f9-717d870cd7ee',   // Unit 3: Travel & Vacation
  spanish: '3112b8d6-3ae6-4679-b9a7-4175c7e78c2b',  // Unit 6: Travel & Culture
  french: '7adb0d1d-1b88-49b9-8f03-8533844c3603',   // Unit 3: Le Passé
  german: 'c37bd4d9-dda1-44b3-a61d-b2888971e2ec',   // Unit 3: Reisen (Travel)
  italian: '474378bb-118e-4967-8fad-a0e65699279a',  // Unit 3: I Viaggi
  japanese: '13dab4f7-7c8d-413d-97e1-fc293f5dc979', // Unit 3: 旅行 (Travel)
  korean: 'f87e8016-a067-4364-bb55-5b402da7b32c',   // Unit 3: 여행 (Travel)
  mandarin: 'd7a38536-5bfc-4a2c-bccc-d2b4d40716f4', // Unit 3: 旅游 (Travel)
  portuguese: '1946451f-1fb4-46bb-a5bb-bc880fa5c786', // Unit 3: As Viagens
};

// Lesson names by language
const LESSON_NAMES: Record<string, string> = {
  english: 'Practice Time: Numbers 21-1000+',
  spanish: 'Práctica: Números 21-1000+',
  french: 'Pratique: Les Nombres 21-1000+',
  german: 'Übung: Zahlen 21-1000+',
  italian: 'Pratica: Numeri 21-1000+',
  japanese: '練習: 数字 21-1000+',
  korean: '연습: 숫자 21-1000+',
  mandarin: '练习：数字 21-1000+',
  portuguese: 'Prática: Números 21-1000+',
};

export async function addIntermediateNumberDrills() {
  const db = getSharedDb();
  const results: { language: string; lessonId: string; drillCount: number }[] = [];

  for (const language of Object.keys(TARGET_UNITS)) {
    const unitId = TARGET_UNITS[language];
    const lessonName = LESSON_NAMES[language];
    const numbers = NUMBER_WORDS[language];

    if (!numbers) {
      console.log(`Skipping ${language} - no number words defined`);
      continue;
    }

    console.log(`Creating lesson for ${language}...`);

    // Create the lesson
    const [lesson] = await db.insert(curriculumLessons).values({
      curriculumUnitId: unitId,
      name: lessonName,
      description: `Practice larger numbers including tens, hundreds, years, and thousands in ${language}.`,
      orderIndex: 99, // Add at end of unit
      lessonType: 'drill',
      actflLevel: 'intermediate_low',
      objectives: [
        'Recognize and understand numbers 21-99',
        'Comprehend hundreds (100-900)',
        'Identify years in spoken form',
        'Understand thousands in context',
      ],
      estimatedMinutes: 15,
      requiredTopics: ['numbers', 'intermediate-numbers'],
      requirementTier: 'recommended',
    }).returning();

    console.log(`  Created lesson: ${lesson.id}`);

    // Create drills for each number
    const drillValues = Object.entries(numbers).map(([numStr, word], index) => {
      const num = parseInt(numStr);
      let difficulty = 3; // Default intermediate
      let tags = ['numbers', 'listening', 'intermediate'];

      // Categorize by number size for difficulty and tags
      if (num < 100) {
        difficulty = 3;
        tags.push('tens');
      } else if (num < 1000) {
        difficulty = 3;
        tags.push('hundreds');
      } else if (num >= 1990 && num <= 2025) {
        difficulty = 4;
        tags.push('years');
      } else {
        difficulty = 4;
        tags.push('thousands');
      }

      return {
        lessonId: lesson.id,
        itemType: 'number_dictation' as const,
        orderIndex: index + 1,
        prompt: word,           // The spoken word (what they hear)
        targetText: numStr,     // The number they type
        targetLanguage: language,
        hints: ['Listen carefully and type the number you hear'],
        difficulty,
        tags,
      };
    });

    await db.insert(curriculumDrillItems).values(drillValues);

    console.log(`  Added ${drillValues.length} drills`);
    results.push({ language, lessonId: lesson.id, drillCount: drillValues.length });
  }

  return results;
}

// Run if executed directly
if (isDirectCliInvocation('add-intermediate-number-drills.ts')) {
  addIntermediateNumberDrills()
    .then((results) => {
      console.log('\n=== Summary ===');
      console.log(`Created ${results.length} lessons with drills:`);
      results.forEach(r => {
        console.log(`  ${r.language}: ${r.drillCount} drills (lesson: ${r.lessonId})`);
      });
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error:', err);
      process.exit(1);
    });
}
