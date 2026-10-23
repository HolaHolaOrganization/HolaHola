/**
 * Script to add intermediate_mid and advanced number drills
 * 
 * Covers:
 * - Large numbers (10000+, millions)
 * - Prices with decimals ($19.99, €45.50)
 * - Percentages (15%, 99.5%)
 * - Ordinals (1st, 22nd)
 */

import { isDirectCliInvocation } from './lib/cli-entrypoint';
import { getSharedDb } from '../db';
import { curriculumLessons, curriculumDrillItems } from '@shared/schema';

// Large numbers and prices by language
const ADVANCED_NUMBERS: Record<string, Record<string, string>> = {
  english: {
    // Large numbers
    '10000': 'ten thousand', '15000': 'fifteen thousand',
    '25000': 'twenty-five thousand', '50000': 'fifty thousand',
    '100000': 'one hundred thousand', '500000': 'five hundred thousand',
    '1000000': 'one million', '2500000': 'two point five million',
    // Prices
    '$9.99': 'nine ninety-nine', '$15.50': 'fifteen fifty',
    '$29.99': 'twenty-nine ninety-nine', '$49.95': 'forty-nine ninety-five',
    '$99.00': 'ninety-nine dollars', '$125.00': 'one hundred twenty-five dollars',
    // Percentages  
    '10%': 'ten percent', '25%': 'twenty-five percent',
    '50%': 'fifty percent', '75%': 'seventy-five percent',
    '99%': 'ninety-nine percent', '100%': 'one hundred percent',
    // Ordinals
    '1st': 'first', '2nd': 'second', '3rd': 'third',
    '21st': 'twenty-first', '22nd': 'twenty-second', '100th': 'one hundredth',
  },
  spanish: {
    '10000': 'diez mil', '15000': 'quince mil',
    '25000': 'veinticinco mil', '50000': 'cincuenta mil',
    '100000': 'cien mil', '500000': 'quinientos mil',
    '1000000': 'un millón', '2500000': 'dos millones y medio',
    '$9.99': 'nueve con noventa y nueve', '$15.50': 'quince con cincuenta',
    '$29.99': 'veintinueve con noventa y nueve', '$49.95': 'cuarenta y nueve con noventa y cinco',
    '$99.00': 'noventa y nueve dólares', '$125.00': 'ciento veinticinco dólares',
    '10%': 'diez por ciento', '25%': 'veinticinco por ciento',
    '50%': 'cincuenta por ciento', '75%': 'setenta y cinco por ciento',
    '99%': 'noventa y nueve por ciento', '100%': 'cien por ciento',
    '1st': 'primero', '2nd': 'segundo', '3rd': 'tercero',
    '21st': 'vigésimo primero', '22nd': 'vigésimo segundo', '100th': 'centésimo',
  },
  french: {
    '10000': 'dix mille', '15000': 'quinze mille',
    '25000': 'vingt-cinq mille', '50000': 'cinquante mille',
    '100000': 'cent mille', '500000': 'cinq cent mille',
    '1000000': 'un million', '2500000': 'deux millions et demi',
    '€9,99': 'neuf euros quatre-vingt-dix-neuf', '€15,50': 'quinze euros cinquante',
    '€29,99': 'vingt-neuf euros quatre-vingt-dix-neuf', '€49,95': 'quarante-neuf euros quatre-vingt-quinze',
    '€99,00': 'quatre-vingt-dix-neuf euros', '€125,00': 'cent vingt-cinq euros',
    '10%': 'dix pour cent', '25%': 'vingt-cinq pour cent',
    '50%': 'cinquante pour cent', '75%': 'soixante-quinze pour cent',
    '99%': 'quatre-vingt-dix-neuf pour cent', '100%': 'cent pour cent',
    '1er': 'premier', '2e': 'deuxième', '3e': 'troisième',
    '21e': 'vingt et unième', '22e': 'vingt-deuxième', '100e': 'centième',
  },
  german: {
    '10000': 'zehntausend', '15000': 'fünfzehntausend',
    '25000': 'fünfundzwanzigtausend', '50000': 'fünfzigtausend',
    '100000': 'hunderttausend', '500000': 'fünfhunderttausend',
    '1000000': 'eine Million', '2500000': 'zweieinhalb Millionen',
    '€9,99': 'neun Euro neunundneunzig', '€15,50': 'fünfzehn Euro fünfzig',
    '€29,99': 'neunundzwanzig Euro neunundneunzig', '€49,95': 'neunundvierzig Euro fünfundneunzig',
    '€99,00': 'neunundneunzig Euro', '€125,00': 'einhundertfünfundzwanzig Euro',
    '10%': 'zehn Prozent', '25%': 'fünfundzwanzig Prozent',
    '50%': 'fünfzig Prozent', '75%': 'fünfundsiebzig Prozent',
    '99%': 'neunundneunzig Prozent', '100%': 'hundert Prozent',
    '1.': 'erster', '2.': 'zweiter', '3.': 'dritter',
    '21.': 'einundzwanzigster', '22.': 'zweiundzwanzigster', '100.': 'hundertster',
  },
  italian: {
    '10000': 'diecimila', '15000': 'quindicimila',
    '25000': 'venticinquemila', '50000': 'cinquantamila',
    '100000': 'centomila', '500000': 'cinquecentomila',
    '1000000': 'un milione', '2500000': 'due milioni e mezzo',
    '€9,99': 'nove euro e novantanove', '€15,50': 'quindici euro e cinquanta',
    '€29,99': 'ventinove euro e novantanove', '€49,95': 'quarantanove euro e novantacinque',
    '€99,00': 'novantanove euro', '€125,00': 'centovinticinque euro',
    '10%': 'dieci per cento', '25%': 'venticinque per cento',
    '50%': 'cinquanta per cento', '75%': 'settantacinque per cento',
    '99%': 'novantanove per cento', '100%': 'cento per cento',
    '1°': 'primo', '2°': 'secondo', '3°': 'terzo',
    '21°': 'ventunesimo', '22°': 'ventiduesimo', '100°': 'centesimo',
  },
  portuguese: {
    '10000': 'dez mil', '15000': 'quinze mil',
    '25000': 'vinte e cinco mil', '50000': 'cinquenta mil',
    '100000': 'cem mil', '500000': 'quinhentos mil',
    '1000000': 'um milhão', '2500000': 'dois milhões e meio',
    'R$9,99': 'nove reais e noventa e nove', 'R$15,50': 'quinze reais e cinquenta',
    'R$29,99': 'vinte e nove reais e noventa e nove', 'R$49,95': 'quarenta e nove reais e noventa e cinco',
    'R$99,00': 'noventa e nove reais', 'R$125,00': 'cento e vinte e cinco reais',
    '10%': 'dez por cento', '25%': 'vinte e cinco por cento',
    '50%': 'cinquenta por cento', '75%': 'setenta e cinco por cento',
    '99%': 'noventa e nove por cento', '100%': 'cem por cento',
    '1º': 'primeiro', '2º': 'segundo', '3º': 'terceiro',
    '21º': 'vigésimo primeiro', '22º': 'vigésimo segundo', '100º': 'centésimo',
  },
  japanese: {
    '10000': '一万', '15000': '一万五千',
    '25000': '二万五千', '50000': '五万',
    '100000': '十万', '500000': '五十万',
    '1000000': '百万', '2500000': '二百五十万',
    '¥999': 'きゅうひゃくきゅうじゅうきゅうえん', '¥1500': 'せんごひゃくえん',
    '¥2999': 'にせんきゅうひゃくきゅうじゅうきゅうえん', '¥4995': 'よんせんきゅうひゃくきゅうじゅうごえん',
    '¥9900': 'きゅうせんきゅうひゃくえん', '¥12500': 'いちまんにせんごひゃくえん',
    '10%': 'じゅっパーセント', '25%': 'にじゅうごパーセント',
    '50%': 'ごじゅっパーセント', '75%': 'ななじゅうごパーセント',
    '99%': 'きゅうじゅうきゅうパーセント', '100%': 'ひゃくパーセント',
    '1番目': 'いちばんめ', '2番目': 'にばんめ', '3番目': 'さんばんめ',
    '21番目': 'にじゅういちばんめ', '22番目': 'にじゅうにばんめ', '100番目': 'ひゃくばんめ',
  },
  korean: {
    '10000': '만', '15000': '만 오천',
    '25000': '이만 오천', '50000': '오만',
    '100000': '십만', '500000': '오십만',
    '1000000': '백만', '2500000': '이백오십만',
    '₩999': '구백구십구 원', '₩1500': '천오백 원',
    '₩2999': '이천구백구십구 원', '₩4995': '사천구백구십오 원',
    '₩9900': '구천구백 원', '₩12500': '만이천오백 원',
    '10%': '십 퍼센트', '25%': '이십오 퍼센트',
    '50%': '오십 퍼센트', '75%': '칠십오 퍼센트',
    '99%': '구십구 퍼센트', '100%': '백 퍼센트',
    '첫째': '첫째', '둘째': '둘째', '셋째': '셋째',
    '스물한번째': '스물한번째', '스물두번째': '스물두번째', '백번째': '백번째',
  },
  mandarin: {
    '10000': '一万', '15000': '一万五千',
    '25000': '两万五千', '50000': '五万',
    '100000': '十万', '500000': '五十万',
    '1000000': '一百万', '2500000': '两百五十万',
    '¥9.99': '九块九毛九', '¥15.50': '十五块五毛',
    '¥29.99': '二十九块九毛九', '¥49.95': '四十九块九毛五',
    '¥99.00': '九十九块', '¥125.00': '一百二十五块',
    '10%': '百分之十', '25%': '百分之二十五',
    '50%': '百分之五十', '75%': '百分之七十五',
    '99%': '百分之九十九', '100%': '百分之百',
    '第一': '第一', '第二': '第二', '第三': '第三',
    '第二十一': '第二十一', '第二十二': '第二十二', '第一百': '第一百',
  },
};

// Target units for intermediate_mid
const TARGET_UNITS: Record<string, string> = {
  english: 'ba075983-2a63-44ac-a2bc-5153d2c8398f',
  spanish: '90d8c742-72de-4cdc-ad00-02faaa4ca481',
  french: '0579eaf2-1629-4791-8765-23c7d17d9169',
  german: 'ca0c01d3-c5f8-4936-b9dc-87b137b5c680',
  italian: 'c66a6a2d-da11-4c58-bc2b-4e6211e7a33d',
  japanese: 'bf9db955-99bb-40b4-ba3a-c5534b7a5a1d',
  korean: 'ee04ae76-bbae-4ad3-a16a-1417efc2ab31',
  mandarin: 'c2bd6c3a-b43f-425e-8acd-4b4c6cd40ea1',
  portuguese: '50a198bb-f0f2-4a18-be58-ca1ad1b8eeb1',
};

const LESSON_NAMES: Record<string, string> = {
  english: 'Practice Time: Large Numbers, Prices & Percentages',
  spanish: 'Práctica: Números Grandes, Precios y Porcentajes',
  french: 'Pratique: Grands Nombres, Prix et Pourcentages',
  german: 'Übung: Große Zahlen, Preise und Prozentsätze',
  italian: 'Pratica: Grandi Numeri, Prezzi e Percentuali',
  japanese: '練習: 大きな数字、価格、パーセント',
  korean: '연습: 큰 숫자, 가격, 퍼센트',
  mandarin: '练习：大数字、价格和百分比',
  portuguese: 'Prática: Números Grandes, Preços e Porcentagens',
};

export async function addAdvancedNumberDrills() {
  const db = getSharedDb();
  const results: { language: string; lessonId: string; drillCount: number }[] = [];

  for (const language of Object.keys(TARGET_UNITS)) {
    const unitId = TARGET_UNITS[language];
    const lessonName = LESSON_NAMES[language];
    const numbers = ADVANCED_NUMBERS[language];

    if (!numbers) {
      console.log(`Skipping ${language} - no number words defined`);
      continue;
    }

    console.log(`Creating lesson for ${language}...`);

    // Create the lesson
    const [lesson] = await db.insert(curriculumLessons).values({
      curriculumUnitId: unitId,
      name: lessonName,
      description: `Practice large numbers, prices with decimals, percentages, and ordinals in ${language}.`,
      orderIndex: 99,
      lessonType: 'drill',
      actflLevel: 'intermediate_mid',
      objectives: [
        'Understand large numbers (thousands, millions)',
        'Comprehend prices with decimals',
        'Recognize percentages in spoken form',
        'Identify ordinal numbers',
      ],
      estimatedMinutes: 20,
      requiredTopics: ['numbers', 'advanced-numbers', 'prices'],
      requirementTier: 'recommended',
    }).returning();

    console.log(`  Created lesson: ${lesson.id}`);

    // Create drills
    const drillValues = Object.entries(numbers).map(([numStr, word], index) => {
      let difficulty = 4; // Default advanced
      let tags = ['numbers', 'listening', 'intermediate-mid'];

      // Categorize
      if (numStr.includes('$') || numStr.includes('€') || numStr.includes('¥') || numStr.includes('₩') || numStr.includes('R$')) {
        tags.push('prices');
        difficulty = 4;
      } else if (numStr.includes('%')) {
        tags.push('percentages');
        difficulty = 4;
      } else if (numStr.match(/\d+(st|nd|rd|th|º|°|e|er|番目|째)/)) {
        tags.push('ordinals');
        difficulty = 4;
      } else if (parseInt(numStr.replace(/,/g, '')) >= 100000) {
        tags.push('millions');
        difficulty = 5;
      } else {
        tags.push('thousands');
        difficulty = 4;
      }

      return {
        lessonId: lesson.id,
        itemType: 'number_dictation' as const,
        orderIndex: index + 1,
        prompt: word,
        targetText: numStr,
        targetLanguage: language,
        hints: ['Listen carefully and type the number, price, or percentage you hear'],
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
if (isDirectCliInvocation('add-advanced-number-drills.ts')) {
  addAdvancedNumberDrills()
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
