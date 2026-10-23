import { isDirectCliInvocation } from "./lib/cli-entrypoint";
import { db } from "../db";
import { 
  classCurriculumLessons, 
  classCurriculumUnits,
  curriculumLessons,
  curriculumUnits,
  teacherClasses
} from "@shared/schema";
import { eq, and, isNotNull } from "drizzle-orm";

/**
 * Sync class syllabi from their source curriculum templates.
 * Updates lesson names and descriptions to match the template.
 */
export async function syncClassSyllabiFromTemplates(): Promise<{
  classesProcessed: number;
  unitsUpdated: number;
  lessonsUpdated: number;
  errors: string[];
}> {
  console.log("[Syllabus Sync] Syncing class syllabi from curriculum templates...\n");
  
  const errors: string[] = [];
  let classesProcessed = 0;
  let unitsUpdated = 0;
  let lessonsUpdated = 0;
  
  // Get all classes with curriculum templates
  const classes = await db
    .select()
    .from(teacherClasses)
    .where(isNotNull(teacherClasses.curriculumPathId));
  
  console.log(`[Syllabus Sync] Found ${classes.length} classes with curriculum templates\n`);
  
  for (const teacherClass of classes) {
    console.log(`Processing: ${teacherClass.name}`);
    
    // Get class units with their source unit IDs
    const classUnits = await db
      .select()
      .from(classCurriculumUnits)
      .where(eq(classCurriculumUnits.classId, teacherClass.id));
    
    for (const classUnit of classUnits) {
      if (!classUnit.sourceUnitId) continue;
      
      // Get the source unit from curriculum template
      const [sourceUnit] = await db
        .select()
        .from(curriculumUnits)
        .where(eq(curriculumUnits.id, classUnit.sourceUnitId));
      
      if (!sourceUnit) continue;
      
      // Update class unit description from source
      await db
        .update(classCurriculumUnits)
        .set({ 
          description: sourceUnit.description,
          commitments: sourceUnit.commitments
        })
        .where(eq(classCurriculumUnits.id, classUnit.id));
      
      unitsUpdated++;
      
      // Get class lessons for this unit
      const classLessons = await db
        .select()
        .from(classCurriculumLessons)
        .where(eq(classCurriculumLessons.classUnitId, classUnit.id));
      
      for (const classLesson of classLessons) {
        if (!classLesson.sourceLessonId) continue;
        
        // Get the source lesson from curriculum template
        const [sourceLesson] = await db
          .select()
          .from(curriculumLessons)
          .where(eq(curriculumLessons.id, classLesson.sourceLessonId));
        
        if (!sourceLesson) continue;
        
        // Update class lesson from source
        await db
          .update(classCurriculumLessons)
          .set({
            name: sourceLesson.name,
            description: sourceLesson.description,
            requirementTier: sourceLesson.requirementTier,
            bundleId: sourceLesson.bundleId,
            linkedDrillLessonId: sourceLesson.linkedDrillLessonId
          })
          .where(eq(classCurriculumLessons.id, classLesson.id));
        
        lessonsUpdated++;
      }
    }
    
    console.log(`   ✅ ${teacherClass.name}: synced`);
    classesProcessed++;
  }
  
  console.log("\n[Syllabus Sync] Summary:");
  console.log(`   Classes processed: ${classesProcessed}`);
  console.log(`   Units updated: ${unitsUpdated}`);
  console.log(`   Lessons updated: ${lessonsUpdated}`);
  
  return { classesProcessed, unitsUpdated, lessonsUpdated, errors };
}

// Run if called directly
if (isDirectCliInvocation("sync-class-syllabi.ts")) {
  syncClassSyllabiFromTemplates()
    .then(result => {
      console.log("\nComplete!", result);
      process.exit(0);
    })
    .catch(err => {
      console.error("Error:", err);
      process.exit(1);
    });
}
