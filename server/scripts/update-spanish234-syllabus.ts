import { isDirectCliInvocation } from "./lib/cli-entrypoint";
import { db } from "../db";
import { curriculumLessons, curriculumUnits, curriculumPaths } from "@shared/schema";
import { eq, and, like } from "drizzle-orm";

/**
 * Apply engaging label transformations to Spanish 2, 3, 4 curricula
 */

// Mapping from lesson types to engaging prefixes
const lessonTypeTransforms: Record<string, string> = {
  vocabulary: "New Words:",
  conversation: "Let's Chat:",
  grammar: "Grammar Spotlight:",
  cultural_exploration: "Culture Corner:",
  drill: "Practice Time:",
};

// Extract topic from lesson name (removes "Lesson N:" prefix)
function extractTopic(name: string): string {
  // Remove "Lesson N: " or "Gramática: " prefix
  const withoutPrefix = name
    .replace(/^Lesson \d+:\s*/i, "")
    .replace(/^Gramática:\s*/i, "");
  return withoutPrefix;
}

// Transform lesson name to engaging format
function transformLessonName(name: string, lessonType: string): string {
  const prefix = lessonTypeTransforms[lessonType] || "Let's Chat:";
  const topic = extractTopic(name);
  
  // If it's a grammar lesson, use the topic after the dash
  if (lessonType === "grammar" && topic.includes(" - ")) {
    const parts = topic.split(" - ");
    return `${prefix} ${parts[0]}`;
  }
  
  return `${prefix} ${topic}`;
}

// Enhance description with engaging copy
function enhanceDescription(description: string, lessonType: string): string {
  // If description is already engaging (has punctuation at end, question, exclamation), keep it
  if (description.endsWith("!") || description.endsWith("?") || description.length > 100) {
    return description;
  }
  
  // Add engaging suffix based on lesson type
  const suffixes: Record<string, string[]> = {
    vocabulary: [
      " Build your vocabulary with practical words you'll use every day!",
      " Master these essential words and phrases!",
    ],
    conversation: [
      " Practice speaking naturally about real-life situations!",
      " Build confidence through interactive conversation!",
    ],
    grammar: [
      " Unlock this key to natural-sounding Spanish!",
      " Master this essential grammar pattern!",
    ],
    cultural_exploration: [
      " Discover fascinating aspects of Hispanic cultures!",
      " Explore the rich traditions of the Spanish-speaking world!",
    ],
  };
  
  const typeSuffixes = suffixes[lessonType] || suffixes.conversation;
  const suffix = typeSuffixes[Math.floor(Math.random() * typeSuffixes.length)];
  
  return description + suffix;
}

// Unit description enhancements
function enhanceUnitDescription(description: string): string {
  if (description.endsWith("!") || description.endsWith("?") || description.length > 150) {
    return description;
  }
  
  // Add engaging wrapper
  return description + " Get ready to communicate with confidence!";
}

export async function updateSpanish234Syllabus(): Promise<{
  pathsUpdated: number;
  unitsUpdated: number;
  lessonsUpdated: number;
  errors: string[];
}> {
  console.log("[Spanish 2-4 Update] Starting syllabus transformation...\n");
  
  const errors: string[] = [];
  let pathsUpdated = 0;
  let unitsUpdated = 0;
  let lessonsUpdated = 0;
  
  // Get Spanish 2, 3, 4 paths
  const paths = await db
    .select()
    .from(curriculumPaths)
    .where(
      and(
        eq(curriculumPaths.language, "spanish"),
        like(curriculumPaths.name, "Spanish%")
      )
    );
  
  const targetPaths = paths.filter(p => 
    p.name.includes("Spanish 2") || 
    p.name.includes("Spanish 3") || 
    p.name.includes("Spanish 4")
  );
  
  for (const path of targetPaths) {
    console.log(`\nProcessing: ${path.name}`);
    pathsUpdated++;
    
    // Get all units for this path
    const units = await db
      .select()
      .from(curriculumUnits)
      .where(eq(curriculumUnits.curriculumPathId, path.id))
      .orderBy(curriculumUnits.orderIndex);
    
    for (const unit of units) {
      // Update unit description
      const newUnitDescription = enhanceUnitDescription(unit.description || "");
      
      await db
        .update(curriculumUnits)
        .set({ description: newUnitDescription })
        .where(eq(curriculumUnits.id, unit.id));
      
      console.log(`  ✅ Unit: ${unit.name}`);
      unitsUpdated++;
      
      // Get all lessons for this unit
      const lessons = await db
        .select()
        .from(curriculumLessons)
        .where(eq(curriculumLessons.curriculumUnitId, unit.id))
        .orderBy(curriculumLessons.orderIndex);
      
      for (const lesson of lessons) {
        const newName = transformLessonName(lesson.name, lesson.lessonType || "conversation");
        const newDescription = enhanceDescription(lesson.description || "", lesson.lessonType || "conversation");
        
        await db
          .update(curriculumLessons)
          .set({
            name: newName,
            description: newDescription,
          })
          .where(eq(curriculumLessons.id, lesson.id));
        
        console.log(`    → ${lesson.name}`);
        console.log(`      ${newName}`);
        lessonsUpdated++;
      }
    }
  }
  
  console.log("\n[Spanish 2-4 Update] Summary:");
  console.log(`   Paths updated: ${pathsUpdated}`);
  console.log(`   Units updated: ${unitsUpdated}`);
  console.log(`   Lessons updated: ${lessonsUpdated}`);
  
  return { pathsUpdated, unitsUpdated, lessonsUpdated, errors };
}

// Run if called directly
if (isDirectCliInvocation("update-spanish234-syllabus.ts")) {
  updateSpanish234Syllabus()
    .then(result => {
      console.log("\nComplete!", result);
      process.exit(0);
    })
    .catch(err => {
      console.error("Error:", err);
      process.exit(1);
    });
}
