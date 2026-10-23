import { isDirectCliInvocation } from "./lib/cli-entrypoint";
import { db } from "../db";
import { curriculumLessons, curriculumUnits, curriculumPaths } from "@shared/schema";
import { eq, and } from "drizzle-orm";

interface LessonUpdate {
  originalName: string;
  newName: string;
  newDescription: string;
  requirementTier?: 'required' | 'recommended' | 'optional_premium';
}

interface UnitUpdate {
  unitName: string;
  newDescription: string;
  lessons: LessonUpdate[];
}

const spanish1Updates: UnitUpdate[] = [
  {
    unitName: "Unit 1: ¡Hola! Greetings & Introductions",
    newDescription: "Your Spanish journey starts here! Master the art of greeting, introducing yourself, and navigating classroom conversations with confidence. Cultural focus: Discover the 21 countries where Spanish is spoken!",
    lessons: [
      {
        originalName: "Lesson 1: Saludos - Greetings & Farewells",
        newName: "Practice Time: Greetings & Farewells",
        newDescription: "Say hello and goodbye like a native! Practice greetings for different times of day and learn when to use formal vs. informal expressions."
      },
      {
        originalName: "Lesson 2: Presentaciones - Introducing Yourself",
        newName: "Let's Chat: Meeting New People",
        newDescription: "Introduce yourself with confidence! Learn to say your name, ask others' names, and make a great first impression. Challenge: Introduce yourself three different ways!"
      },
      {
        originalName: "Lesson 3: Los Números - Numbers 0-20",
        newName: "Practice Time: Numbers 0-20",
        newDescription: "Count, share your age, and exchange phone numbers. You'll practice until numbers flow naturally!"
      },
      {
        originalName: "Lesson 4: En la Clase - Classroom Expressions",
        newName: "Let's Chat: Classroom Survival",
        newDescription: "Never feel lost in class again! Learn essential expressions like \"How do you say...?\" and \"Can you repeat that?\""
      }
    ]
  },
  {
    unitName: "Unit 2: Mi Familia - Family & Relationships",
    newDescription: "Introduce your loved ones! By the end, you'll describe family members, share ages and birthdays, and explore how Hispanic families stay connected. Cultural focus: The importance of family in Hispanic cultures.",
    lessons: [
      {
        originalName: "Lesson 1: La Familia - Family Members",
        newName: "New Words: Meet the Family",
        newDescription: "Learn to name all your family members. Challenge: Create a family tree and describe everyone in Spanish!"
      },
      {
        originalName: "Lesson 2: Descripciones - Describing People",
        newName: "Let's Chat: Who's Who?",
        newDescription: "Describe family members using appearance and personality words. Can you paint a picture with words?"
      },
      {
        originalName: "Lesson 3: Edad y Cumpleaños - Ages & Birthdays",
        newName: "Let's Chat: Birthday Celebrations",
        newDescription: "Talk about ages and birthdays. Learn the months and practice asking \"When is your birthday?\""
      },
      {
        originalName: "Lesson 4: La Familia Hispana",
        newName: "Culture Corner: Hispanic Family Life",
        newDescription: "Explore how families connect across generations in Hispanic cultures. What traditions might you adopt?"
      },
      {
        originalName: "Gramática: Concordancia - Gender & Number Agreement",
        newName: "Grammar Spotlight: Agreement",
        newDescription: "Master noun-adjective agreement. Why does \"alto\" become \"alta\"? Unlock this key to natural-sounding Spanish!"
      }
    ]
  },
  {
    unitName: "Unit 3: La Escuela - School Life",
    newDescription: "Navigate school life in Spanish! Discuss your favorite subjects, describe your schedule, and compare education systems. Cultural focus: What's school like in Latin America?",
    lessons: [
      {
        originalName: "Lesson 1: Las Materias",
        newName: "New Words: School Subjects",
        newDescription: "What's your favorite class? Learn subject names and share your opinions!"
      },
      {
        originalName: "Lesson 2: El Horario",
        newName: "Let's Chat: My Schedule",
        newDescription: "Describe your daily schedule. Practice telling time and talking about when things happen."
      },
      {
        originalName: "Lesson 3: Los Útiles Escolares",
        newName: "New Words: School Supplies",
        newDescription: "Pack your backpack! Learn the Spanish words for all your school essentials."
      },
      {
        originalName: "Lesson 4: La Educación",
        newName: "Let's Chat: School Around the World",
        newDescription: "Compare education systems. What's different about school in Spanish-speaking countries?"
      },
      {
        originalName: "Gramática: Verbos -AR - Present Tense Regular Verbs",
        newName: "Grammar Spotlight: -AR Verbs",
        newDescription: "Unlock the power of verbs! Learn to conjugate regular -AR verbs and describe daily actions."
      }
    ]
  },
  {
    unitName: "Unit 4: Mis Pasatiempos - Hobbies & Free Time",
    newDescription: "What do you do for fun? Talk about sports, hobbies, and weekend plans. Cultural focus: Popular pastimes in the Spanish-speaking world!",
    lessons: [
      {
        originalName: "Lesson 1: Los Pasatiempos",
        newName: "New Words: Hobbies",
        newDescription: "From gaming to painting, learn to talk about what you love doing!"
      },
      {
        originalName: "Lesson 2: Los Deportes",
        newName: "Let's Chat: Sports Talk",
        newDescription: "Discuss your favorite sports. Challenge: Interview a classmate about their sports preferences!"
      },
      {
        originalName: "Lesson 3: La Música y el Cine",
        newName: "Culture Corner: Music & Movies",
        newDescription: "Explore Spanish-language music and film. Discover artists and genres you'll love!"
      },
      {
        originalName: "Lesson 4: El Fin de Semana",
        newName: "Let's Chat: Weekend Plans",
        newDescription: "What are you doing this weekend? Practice making and discussing plans."
      }
    ]
  },
  {
    unitName: "Unit 5: La Comida - Food & Dining",
    newDescription: "Get hungry for Spanish! Master food vocabulary, order at restaurants like a pro, and explore delicious Hispanic cuisine. Cultural focus: Regional dishes you need to try!",
    lessons: [
      {
        originalName: "Lesson 1: La Comida",
        newName: "New Words: Food Favorites",
        newDescription: "Learn delicious food vocabulary! Challenge: Describe your perfect breakfast, lunch, and dinner!"
      },
      {
        originalName: "Lesson 2: Las Bebidas",
        newName: "New Words: Drinks",
        newDescription: "From café con leche to fresh juices, learn to order your favorite beverages."
      },
      {
        originalName: "Lesson 3: En el Restaurante",
        newName: "Let's Chat: Restaurant Ordering",
        newDescription: "Order a full meal confidently! Practice with menus and build your own order."
      },
      {
        originalName: "Lesson 4: Comida Hispana",
        newName: "Culture Corner: Hispanic Cuisine",
        newDescription: "Explore tacos, paella, empanadas, and more. What will you try first?"
      },
      {
        originalName: "Gramática: Verbos Irregulares - Stem-Changing Verbs",
        newName: "Grammar Spotlight: Stem-Changers",
        newDescription: "Master tricky stem-changing verbs (querer, poder, pedir). The secret to sounding natural!"
      }
    ]
  },
  {
    unitName: "Unit 6: De Compras - Shopping & Clothing",
    newDescription: "Ready to shop? Learn to describe clothes, ask about sizes and prices, and navigate stores with confidence. Cultural focus: Markets, boutiques, and shopping culture!",
    lessons: [
      {
        originalName: "Lesson 1: La Ropa",
        newName: "New Words: Clothing Essentials",
        newDescription: "Build your wardrobe vocabulary! Describe what you're wearing right now."
      },
      {
        originalName: "Lesson 2: Los Colores y Tallas",
        newName: "New Words: Colors & Sizes",
        newDescription: "Red or blue? Small or large? Learn to specify exactly what you want."
      },
      {
        originalName: "Lesson 3: En la Tienda",
        newName: "Let's Chat: At the Store",
        newDescription: "Shop like a pro! Ask prices, request sizes, and make purchases. Challenge: Haggle at a market!"
      },
      {
        originalName: "Lesson 4: Las Compras",
        newName: "Let's Chat: Shopping Stories",
        newDescription: "Share shopping experiences and preferences. Where's your favorite place to shop?"
      }
    ]
  },
  {
    unitName: "Unit 7: La Ciudad - Places in the Community",
    newDescription: "Navigate your neighborhood and beyond! Learn city vocabulary, give directions, and explore urban life in Spanish-speaking countries. Cultural focus: City life from Madrid to Mexico City!",
    lessons: [
      {
        originalName: "Lesson 1: Los Lugares",
        newName: "New Words: Places in Town",
        newDescription: "Bank, pharmacy, supermarket... Learn where everything is!"
      },
      {
        originalName: "Lesson 2: Las Direcciones",
        newName: "Let's Chat: Giving Directions",
        newDescription: "Guide someone to their destination! Practice left, right, straight, and more."
      },
      {
        originalName: "Lesson 3: El Transporte",
        newName: "Let's Chat: Getting Around",
        newDescription: "Bus, metro, taxi... How do you get there? Discuss transportation options."
      },
      {
        originalName: "Lesson 4: Las Ciudades",
        newName: "Let's Chat: City Life",
        newDescription: "Describe your city and compare with Spanish-speaking cities. Where would you visit?"
      }
    ]
  },
  {
    unitName: "Unit 8: Las Vacaciones - Travel & Vacation",
    newDescription: "Adventure awaits! Plan trips, discuss weather, book hotels, and dream about destinations across the Spanish-speaking world. Cultural focus: Must-visit destinations!",
    lessons: [
      {
        originalName: "Lesson 1: Las Vacaciones",
        newName: "New Words: Travel Essentials",
        newDescription: "Pack your bags! Learn the vocabulary for your next adventure."
      },
      {
        originalName: "Lesson 2: El Clima",
        newName: "Let's Chat: Weather Talk",
        newDescription: "Hot or cold? Sunny or rainy? Discuss weather for trip planning."
      },
      {
        originalName: "Lesson 3: En el Hotel",
        newName: "Let's Chat: Hotel Check-in",
        newDescription: "Book a room, ask about amenities, and handle common hotel situations."
      },
      {
        originalName: "Lesson 4: Destinos Hispanos",
        newName: "Culture Corner: Dream Destinations",
        newDescription: "Explore beaches, mountains, and cities across 21 countries. Where's your dream destination?"
      }
    ]
  }
];

export async function updateSpanish1Syllabus(): Promise<{
  unitsUpdated: number;
  lessonsUpdated: number;
  errors: string[];
}> {
  console.log("[Spanish 1 Update] Starting syllabus transformation...\n");
  
  const errors: string[] = [];
  let unitsUpdated = 0;
  let lessonsUpdated = 0;
  
  // Find Spanish 1 path
  const [spanish1Path] = await db
    .select()
    .from(curriculumPaths)
    .where(eq(curriculumPaths.name, "Spanish 1 - High School"));
  
  if (!spanish1Path) {
    return { unitsUpdated: 0, lessonsUpdated: 0, errors: ["Spanish 1 path not found"] };
  }
  
  console.log(`[Spanish 1 Update] Found path: ${spanish1Path.name} (${spanish1Path.id})\n`);
  
  for (const unitUpdate of spanish1Updates) {
    // Find the unit
    const [unit] = await db
      .select()
      .from(curriculumUnits)
      .where(
        and(
          eq(curriculumUnits.curriculumPathId, spanish1Path.id),
          eq(curriculumUnits.name, unitUpdate.unitName)
        )
      );
    
    if (!unit) {
      errors.push(`Unit not found: ${unitUpdate.unitName}`);
      console.log(`❌ Unit not found: ${unitUpdate.unitName}`);
      continue;
    }
    
    // Update unit description
    await db
      .update(curriculumUnits)
      .set({ description: unitUpdate.newDescription })
      .where(eq(curriculumUnits.id, unit.id));
    
    console.log(`✅ Updated unit: ${unitUpdate.unitName}`);
    unitsUpdated++;
    
    // Update lessons in this unit
    for (const lessonUpdate of unitUpdate.lessons) {
      const [lesson] = await db
        .select()
        .from(curriculumLessons)
        .where(
          and(
            eq(curriculumLessons.curriculumUnitId, unit.id),
            eq(curriculumLessons.name, lessonUpdate.originalName)
          )
        );
      
      if (!lesson) {
        // Try partial match for lessons that may have slightly different names
        const allLessons = await db
          .select()
          .from(curriculumLessons)
          .where(eq(curriculumLessons.curriculumUnitId, unit.id));
        
        const matchedLesson = allLessons.find(l => 
          l.name.includes(lessonUpdate.originalName.split(":")[1]?.trim() || "") ||
          lessonUpdate.originalName.includes(l.name.split(":")[1]?.trim() || "")
        );
        
        if (!matchedLesson) {
          errors.push(`Lesson not found: ${lessonUpdate.originalName} in ${unitUpdate.unitName}`);
          console.log(`   ❌ Lesson not found: ${lessonUpdate.originalName}`);
          continue;
        }
        
        await db
          .update(curriculumLessons)
          .set({
            name: lessonUpdate.newName,
            description: lessonUpdate.newDescription,
            ...(lessonUpdate.requirementTier && { requirementTier: lessonUpdate.requirementTier })
          })
          .where(eq(curriculumLessons.id, matchedLesson.id));
        
        console.log(`   ✅ Updated (fuzzy): ${matchedLesson.name} → ${lessonUpdate.newName}`);
        lessonsUpdated++;
      } else {
        await db
          .update(curriculumLessons)
          .set({
            name: lessonUpdate.newName,
            description: lessonUpdate.newDescription,
            ...(lessonUpdate.requirementTier && { requirementTier: lessonUpdate.requirementTier })
          })
          .where(eq(curriculumLessons.id, lesson.id));
        
        console.log(`   ✅ Updated: ${lessonUpdate.originalName} → ${lessonUpdate.newName}`);
        lessonsUpdated++;
      }
    }
    
    console.log("");
  }
  
  console.log("\n[Spanish 1 Update] Summary:");
  console.log(`   Units updated: ${unitsUpdated}`);
  console.log(`   Lessons updated: ${lessonsUpdated}`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.length}`);
    errors.forEach(e => console.log(`      - ${e}`));
  }
  
  return { unitsUpdated, lessonsUpdated, errors };
}

// Run if called directly
if (isDirectCliInvocation("update-spanish-syllabus.ts")) {
  updateSpanish1Syllabus()
    .then(result => {
      console.log("\nComplete!", result);
      process.exit(0);
    })
    .catch(err => {
      console.error("Error:", err);
      process.exit(1);
    });
}
