/**
 * Generalized Syllabus Label Transformer
 * 
 * Transforms clinical lesson names into engaging labels based on lesson_type:
 * - drill → "Practice Time: [topic]"
 * - conversation → "Let's Chat: [topic]"
 * - vocabulary → "New Words: [topic]"
 * - cultural_exploration → "Culture Corner: [topic]"
 * - grammar → "Grammar Spotlight: [topic]"
 * 
 * Also updates descriptions to be more inviting using pattern templates.
 */

import { isDirectCliInvocation } from "./lib/cli-entrypoint";
import { db } from "../db";
import { curriculumLessons, curriculumUnits, curriculumPaths } from "@shared/schema";
import { eq, and, like, or } from "drizzle-orm";

const LABEL_PREFIXES: Record<string, string> = {
  drill: "Practice Time:",
  conversation: "Let's Chat:",
  vocabulary: "New Words:",
  cultural_exploration: "Culture Corner:",
  grammar: "Grammar Spotlight:",
};

const DESCRIPTION_TEMPLATES: Record<string, (topic: string) => string> = {
  drill: (topic) => `Master ${topic.toLowerCase()} through interactive practice! Build confidence with guided exercises.`,
  conversation: (topic) => `Practice real conversations about ${topic.toLowerCase()}. Challenge: Can you keep the conversation going?`,
  vocabulary: (topic) => `Learn essential ${topic.toLowerCase()} vocabulary. Build your word bank with practical terms you'll use every day!`,
  cultural_exploration: (topic) => `Explore the rich culture behind ${topic.toLowerCase()}. Discover traditions, customs, and what makes this topic special!`,
  grammar: (topic) => `Unlock the patterns of ${topic.toLowerCase()}. Master this key concept to sound more natural!`,
};

function extractTopic(lessonName: string): string {
  const colonIndex = lessonName.indexOf(':');
  if (colonIndex === -1) return lessonName;
  
  let topic = lessonName.substring(colonIndex + 1).trim();
  
  if (topic.includes(' - ')) {
    topic = topic.split(' - ')[1]?.trim() || topic.split(' - ')[0]?.trim() || topic;
  }
  
  return topic;
}

function isAlreadyTransformed(lessonName: string): boolean {
  const prefixes = Object.values(LABEL_PREFIXES);
  return prefixes.some(prefix => lessonName.startsWith(prefix));
}

export async function updateSyllabusLabels(curriculumName: string): Promise<{
  lessonsUpdated: number;
  lessonsSkipped: number;
  errors: string[];
}> {
  console.log(`\n[Syllabus Update] Starting transformation for: ${curriculumName}\n`);
  
  const errors: string[] = [];
  let lessonsUpdated = 0;
  let lessonsSkipped = 0;
  
  const [path] = await db
    .select()
    .from(curriculumPaths)
    .where(eq(curriculumPaths.name, curriculumName));
  
  if (!path) {
    return { lessonsUpdated: 0, lessonsSkipped: 0, errors: [`Curriculum not found: ${curriculumName}`] };
  }
  
  const units = await db
    .select()
    .from(curriculumUnits)
    .where(eq(curriculumUnits.curriculumPathId, path.id))
    .orderBy(curriculumUnits.orderIndex);
  
  for (const unit of units) {
    console.log(`📁 Unit: ${unit.name}`);
    
    const lessons = await db
      .select()
      .from(curriculumLessons)
      .where(eq(curriculumLessons.curriculumUnitId, unit.id))
      .orderBy(curriculumLessons.orderIndex);
    
    for (const lesson of lessons) {
      if (isAlreadyTransformed(lesson.name)) {
        console.log(`   ⏭️  Already transformed: ${lesson.name}`);
        lessonsSkipped++;
        continue;
      }
      
      const lessonType = lesson.lessonType || 'conversation';
      const prefix = LABEL_PREFIXES[lessonType];
      
      if (!prefix) {
        console.log(`   ⚠️  Unknown lesson type: ${lessonType} for ${lesson.name}`);
        lessonsSkipped++;
        continue;
      }
      
      const topic = extractTopic(lesson.name);
      const newName = `${prefix} ${topic}`;
      
      const descriptionGenerator = DESCRIPTION_TEMPLATES[lessonType];
      const newDescription = descriptionGenerator 
        ? descriptionGenerator(topic)
        : lesson.description;
      
      try {
        await db
          .update(curriculumLessons)
          .set({
            name: newName,
            description: newDescription,
          })
          .where(eq(curriculumLessons.id, lesson.id));
        
        console.log(`   ✅ ${lesson.name} → ${newName}`);
        lessonsUpdated++;
      } catch (err: any) {
        errors.push(`Failed to update ${lesson.name}: ${err.message}`);
        console.log(`   ❌ Error updating ${lesson.name}: ${err.message}`);
      }
    }
  }
  
  console.log(`\n[Syllabus Update] Summary for ${curriculumName}:`);
  console.log(`   Lessons updated: ${lessonsUpdated}`);
  console.log(`   Lessons skipped: ${lessonsSkipped}`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.length}`);
    errors.forEach(e => console.log(`      - ${e}`));
  }
  
  return { lessonsUpdated, lessonsSkipped, errors };
}

export async function updateAllNonSpanishCurricula(): Promise<void> {
  const curricula = [
    "French 1 - High School",
    "French 2 - High School",
    "French 3 - High School",
    "German 1 - High School",
    "German 2 - High School",
    "Italian 1 - High School",
    "Italian 2 - High School",
    "Japanese 1 - High School",
    "Japanese 2 - High School",
    "Korean 1 - High School",
    "Korean 2 - High School",
    "Mandarin 1 - High School",
    "Mandarin 2 - High School",
    "Portuguese 1 - High School",
    "Portuguese 2 - High School",
    "English 1 - High School",
    "English 2 - High School",
  ];
  
  console.log("=".repeat(60));
  console.log("UNIFIED SYLLABUS LABEL TRANSFORMATION");
  console.log("=".repeat(60));
  
  const results: Record<string, { updated: number; skipped: number; errors: number }> = {};
  
  for (const curriculum of curricula) {
    const result = await updateSyllabusLabels(curriculum);
    results[curriculum] = {
      updated: result.lessonsUpdated,
      skipped: result.lessonsSkipped,
      errors: result.errors.length,
    };
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(60));
  
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  
  for (const [curriculum, stats] of Object.entries(results)) {
    const status = stats.errors > 0 ? "⚠️" : stats.updated > 0 ? "✅" : "⏭️";
    console.log(`${status} ${curriculum}: ${stats.updated} updated, ${stats.skipped} skipped, ${stats.errors} errors`);
    totalUpdated += stats.updated;
    totalSkipped += stats.skipped;
    totalErrors += stats.errors;
  }
  
  console.log("\n" + "-".repeat(40));
  console.log(`TOTAL: ${totalUpdated} lessons updated, ${totalSkipped} skipped, ${totalErrors} errors`);
}

if (isDirectCliInvocation("update-syllabus-labels.ts")) {
  const curriculumArg = process.argv[2];
  
  if (curriculumArg === "--all") {
    updateAllNonSpanishCurricula()
      .then(() => {
        console.log("\nComplete!");
        process.exit(0);
      })
      .catch(err => {
        console.error("Error:", err);
        process.exit(1);
      });
  } else if (curriculumArg) {
    updateSyllabusLabels(curriculumArg)
      .then(result => {
        console.log("\nComplete!", result);
        process.exit(0);
      })
      .catch(err => {
        console.error("Error:", err);
        process.exit(1);
      });
  } else {
    console.log("Usage:");
    console.log("  npx tsx server/scripts/update-syllabus-labels.ts 'French 1 - High School'");
    console.log("  npx tsx server/scripts/update-syllabus-labels.ts --all");
    process.exit(1);
  }
}
