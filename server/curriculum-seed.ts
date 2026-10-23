import { isDirectCliInvocation } from "./scripts/lib/cli-entrypoint";
import { db } from "./db";
import { curriculumPaths, curriculumUnits, curriculumLessons } from "@shared/schema";

/**
 * Pre-Built Curriculum Content for HolaHola
 * 
 * Comprehensive, standards-aligned curriculum paths for:
 * - Spanish 1-4 (Novice Low → Intermediate High)
 * - French 1-3 (Novice Low → Intermediate Mid)
 * 
 * All content aligned with ACTFL World-Readiness Standards
 */

export async function seedCurriculum() {
  console.log("🌱 Seeding pre-built curriculum paths...");

  // SPANISH 1: Novice Low → Novice High
  const [spanish1] = await db.insert(curriculumPaths).values({
    name: "Spanish 1 - High School",
    description: "Foundational Spanish for beginners. Students develop basic communication skills in interpersonal, interpretive, and presentational modes. Focus on everyday topics like greetings, family, school, and personal preferences.",
    language: "spanish",
    targetAudience: "High School",
    startLevel: "novice_low",
    endLevel: "novice_high",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  // Spanish 1 Units
  const spanish1Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: spanish1.id,
      name: "Unit 1: ¡Hola! Greetings & Introductions",
      description: "Basic greetings, introductions, and classroom expressions. Cultural focus: Spanish-speaking countries overview.",
      orderIndex: 1,
      actflLevel: "novice_low",
      culturalTheme: "Spanish-speaking World Geography",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 2: Mi Familia - Family & Relationships",
      description: "Describing family members, ages, and relationships. Cultural focus: Family structure in Hispanic cultures.",
      orderIndex: 2,
      actflLevel: "novice_low",
      culturalTheme: "Hispanic Family Traditions",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 3: La Escuela - School Life",
      description: "School subjects, schedules, and classroom objects. Cultural focus: Education systems in Latin America.",
      orderIndex: 3,
      actflLevel: "novice_mid",
      culturalTheme: "Education in Latin America",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 4: Mis Pasatiempos - Hobbies & Free Time",
      description: "Discussing hobbies, sports, and leisure activities. Cultural focus: Popular sports in Spanish-speaking countries.",
      orderIndex: 4,
      actflLevel: "novice_mid",
      culturalTheme: "Sports & Recreation",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 5: La Comida - Food & Dining",
      description: "Food vocabulary, ordering in restaurants, and meal customs. Cultural focus: Traditional dishes and dining etiquette.",
      orderIndex: 5,
      actflLevel: "novice_mid",
      culturalTheme: "Culinary Traditions",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 6: De Compras - Shopping & Clothing",
      description: "Clothing items, colors, prices, and shopping vocabulary. Cultural focus: Markets and shopping culture.",
      orderIndex: 6,
      actflLevel: "novice_high",
      culturalTheme: "Markets & Shopping",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 7: La Ciudad - Places in the Community",
      description: "Locations in town, giving directions, and transportation. Cultural focus: Urban vs. rural life.",
      orderIndex: 7,
      actflLevel: "novice_high",
      culturalTheme: "City Life & Transportation",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish1.id,
      name: "Unit 8: Las Vacaciones - Travel & Vacation",
      description: "Vacation planning, weather, and travel vocabulary. Cultural focus: Popular vacation destinations.",
      orderIndex: 8,
      actflLevel: "novice_high",
      culturalTheme: "Travel & Tourism",
      estimatedHours: 15,
    },
  ]).returning();

  // Spanish 1, Unit 1 Lessons
  await db.insert(curriculumLessons).values([
    {
      curriculumUnitId: spanish1Units[0].id,
      name: "Lesson 1: Greetings & Farewells",
      description: "Learn basic greetings (Hola, Buenos días) and farewells (Adiós, Hasta luego, Hasta pronto)",
      orderIndex: 1,
      lessonType: "conversation",
      actflLevel: "novice_low",
      conversationTopic: "Greet someone and say goodbye in different contexts (morning, afternoon, formal/informal) — including warm farewells like 'hasta pronto' (see you soon)",
      conversationPrompt: "You are a friendly Spanish speaker meeting a student for the first time. Practice basic greetings appropriate for different times of day. Keep responses simple and encourage repetition.",
      objectives: ["I can greet someone", "I can say goodbye", "I can ask how someone is"],
      estimatedMinutes: 30,
    },
    {
      curriculumUnitId: spanish1Units[0].id,
      name: "Lesson 2: Introducing Yourself",
      description: "Learn to say your name, ask someone's name, and exchange basic information",
      orderIndex: 2,
      lessonType: "conversation",
      actflLevel: "novice_low",
      conversationTopic: "Introduce yourself and ask for someone's name using 'Me llamo...' and '¿Cómo se llama usted?'",
      conversationPrompt: "You are a Spanish-speaking adult meeting a new student. Help them practice formal introductions. Use simple present tense (me llamo, se llama). Encourage them to introduce themselves too.",
      objectives: ["I can introduce myself", "I can ask someone's name", "I can respond to an introduction"],
      estimatedMinutes: 30,
    },
    {
      curriculumUnitId: spanish1Units[0].id,
      name: "Lesson 3: Numbers 0-20",
      description: "Count from 0 to 20, ask and tell age, and exchange phone numbers",
      orderIndex: 3,
      lessonType: "vocabulary",
      actflLevel: "novice_low",
      conversationTopic: "Practice numbers by asking and answering age, phone numbers, and simple counting",
      conversationPrompt: "You are a Spanish speaker helping a student practice numbers. Ask their age (¿Cuántos años tienes?) and phone number (¿Cuál es tu número de teléfono?). Keep it simple and repetitive.",
      objectives: ["I can count to 20", "I can tell my age", "I can say my phone number"],
      estimatedMinutes: 25,
    },
    {
      curriculumUnitId: spanish1Units[0].id,
      name: "Lesson 4: Classroom Expressions",
      description: "Essential classroom commands and questions (¿Cómo se dice...?, No entiendo, Repita por favor)",
      orderIndex: 4,
      lessonType: "conversation",
      actflLevel: "novice_low",
      conversationTopic: "Practice asking for help, asking for repetition, and understanding classroom instructions",
      conversationPrompt: "You are a Spanish teacher. Use classroom commands (Siéntate, Levántate, Abre el libro) and help students ask questions like '¿Cómo se dice...?' and 'No entiendo'. Be patient and repeat when asked.",
      objectives: ["I can ask how to say something in Spanish", "I can ask for repetition", "I can say I don't understand"],
      estimatedMinutes: 20,
    },
  ]);

  // Spanish 1, Unit 2 Lessons (Family)
  await db.insert(curriculumLessons).values([
    {
      curriculumUnitId: spanish1Units[1].id,
      name: "Lesson 1: Family Members",
      description: "Vocabulary for immediate family (madre, padre, hermano, hermana, etc.)",
      orderIndex: 1,
      lessonType: "vocabulary",
      actflLevel: "novice_low",
      conversationTopic: "Talk about your family members using basic vocabulary",
      conversationPrompt: "You are a Spanish-speaking friend asking about the student's family. Help them practice family vocabulary (madre, padre, hermano, hermana). Ask simple questions like '¿Tienes hermanos?' and '¿Cómo se llama tu madre?'",
      objectives: ["I can name family members", "I can say how many siblings I have", "I can name my family members"],
      estimatedMinutes: 30,
    },
    {
      curriculumUnitId: spanish1Units[1].id,
      name: "Lesson 2: Describing People",
      description: "Physical descriptions (alto, bajo, rubio, moreno) and personality traits",
      orderIndex: 2,
      lessonType: "conversation",
      actflLevel: "novice_mid",
      conversationTopic: "Describe family members using physical and personality adjectives",
      conversationPrompt: "You are a Spanish speaker curious about the student's family. Help them describe family members using simple adjectives (alto, bajo, rubio, simpático). Model proper adjective agreement but don't overcorrect.",
      objectives: ["I can describe someone's appearance", "I can describe someone's personality", "I can use basic adjectives"],
      estimatedMinutes: 35,
    },
    {
      curriculumUnitId: spanish1Units[1].id,
      name: "Lesson 3: Ages & Birthdays",
      description: "Asking and telling ages, months of the year, and talking about birthdays",
      orderIndex: 3,
      lessonType: "conversation",
      actflLevel: "novice_mid",
      conversationTopic: "Ask and answer questions about ages and birthdays",
      conversationPrompt: "You are planning a birthday party and asking about family members' ages and birthdays. Use '¿Cuántos años tiene...?' and '¿Cuándo es tu cumpleaños?'. Practice months of the year naturally.",
      objectives: ["I can ask someone's age", "I can tell when my birthday is", "I can name the months"],
      estimatedMinutes: 30,
    },
  ]);

  console.log("✅ Spanish 1 curriculum seeded");

  // SPANISH 2: Novice High → Intermediate Low
  const [spanish2] = await db.insert(curriculumPaths).values({
    name: "Spanish 2 - High School",
    description: "Building on Spanish 1, students expand communication skills with more complex topics including health, technology, environment, and cultural practices. Emphasis on past tense narration and extended conversations.",
    language: "spanish",
    targetAudience: "High School",
    startLevel: "novice_high",
    endLevel: "intermediate_low",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  // Spanish 2 Units
  const spanish2Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: spanish2.id,
      name: "Unit 1: Review & Daily Routines",
      description: "Review Spanish 1 content and introduce daily routines using reflexive verbs.",
      orderIndex: 1,
      actflLevel: "novice_high",
      culturalTheme: "Daily Life in Hispanic Countries",
      estimatedHours: 12,
    },
    {
      curriculumPathId: spanish2.id,
      name: "Unit 2: La Salud - Health & Wellness",
      description: "Body parts, illnesses, medical appointments, and healthy living.",
      orderIndex: 2,
      actflLevel: "intermediate_low",
      culturalTheme: "Healthcare Systems",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish2.id,
      name: "Unit 3: La Tecnología - Technology & Social Media",
      description: "Technology vocabulary, social media, and digital communication.",
      orderIndex: 3,
      actflLevel: "intermediate_low",
      culturalTheme: "Technology & Modern Life",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish2.id,
      name: "Unit 4: El Medio Ambiente - Environment & Nature",
      description: "Environmental issues, nature vocabulary, and sustainability.",
      orderIndex: 4,
      actflLevel: "intermediate_low",
      culturalTheme: "Environmental Awareness",
      estimatedHours: 15,
    },
    {
      curriculumPathId: spanish2.id,
      name: "Unit 5: Childhood Memories (Past Tense)",
      description: "Introducing preterite and imperfect past tenses through childhood memories.",
      orderIndex: 5,
      actflLevel: "intermediate_low",
      culturalTheme: "Childhood & Traditions",
      estimatedHours: 18,
    },
    {
      curriculumPathId: spanish2.id,
      name: "Unit 6: Travel & Culture",
      description: "Planning trips, cultural experiences, and famous landmarks.",
      orderIndex: 6,
      actflLevel: "intermediate_low",
      culturalTheme: "Cultural Heritage Sites",
      estimatedHours: 15,
    },
  ]).returning();

  console.log("✅ Spanish 2 curriculum seeded");

  // SPANISH 3: Intermediate Low → Intermediate Mid
  const [spanish3] = await db.insert(curriculumPaths).values({
    name: "Spanish 3 - High School",
    description: "Advanced intermediate Spanish focusing on complex topics like social issues, arts, history, and future planning. Students engage in extended conversations and produce detailed written work.",
    language: "spanish",
    targetAudience: "High School",
    startLevel: "intermediate_low",
    endLevel: "intermediate_mid",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  const spanish3Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: spanish3.id,
      name: "Unit 1: Identity & Social Issues",
      description: "Discussing identity, social justice, and community challenges.",
      orderIndex: 1,
      actflLevel: "intermediate_low",
      culturalTheme: "Social Justice Movements",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish3.id,
      name: "Unit 2: Arts & Literature",
      description: "Exploring Hispanic art, literature, music, and theater.",
      orderIndex: 2,
      actflLevel: "intermediate_mid",
      culturalTheme: "Hispanic Arts & Culture",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish3.id,
      name: "Unit 3: History & Politics",
      description: "Major historical events and political systems in Spanish-speaking countries.",
      orderIndex: 3,
      actflLevel: "intermediate_mid",
      culturalTheme: "Latin American History",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish3.id,
      name: "Unit 4: Future Plans & Careers",
      description: "Discussing future goals, careers, and professional aspirations (future tense).",
      orderIndex: 4,
      actflLevel: "intermediate_mid",
      culturalTheme: "Education & Career Paths",
      estimatedHours: 20,
    },
  ]).returning();

  console.log("✅ Spanish 3 curriculum seeded");

  // SPANISH 4: Intermediate Mid → Intermediate High
  const [spanish4] = await db.insert(curriculumPaths).values({
    name: "Spanish 4 - High School / AP Prep",
    description: "Pre-AP level Spanish emphasizing cultural comparisons, global challenges, and contemporary issues. Preparation for AP Spanish Language exam with focus on all three modes of communication.",
    language: "spanish",
    targetAudience: "High School",
    startLevel: "intermediate_mid",
    endLevel: "intermediate_high",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  const spanish4Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: spanish4.id,
      name: "Unit 1: Global Challenges",
      description: "Climate change, poverty, migration, and global cooperation.",
      orderIndex: 1,
      actflLevel: "intermediate_mid",
      culturalTheme: "Global Issues",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish4.id,
      name: "Unit 2: Science & Innovation",
      description: "Scientific discoveries, technology ethics, and innovation in Hispanic countries.",
      orderIndex: 2,
      actflLevel: "intermediate_high",
      culturalTheme: "STEM in Latin America",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish4.id,
      name: "Unit 3: Cultural Perspectives",
      description: "Analyzing cultural products, practices, and perspectives through authentic texts.",
      orderIndex: 3,
      actflLevel: "intermediate_high",
      culturalTheme: "Cultural Analysis",
      estimatedHours: 20,
    },
    {
      curriculumPathId: spanish4.id,
      name: "Unit 4: AP Exam Preparation",
      description: "Integrated skills practice for AP Spanish Language exam (all three modes).",
      orderIndex: 4,
      actflLevel: "intermediate_high",
      culturalTheme: "Mixed",
      estimatedHours: 20,
    },
  ]).returning();

  console.log("✅ Spanish 4 curriculum seeded");

  // FRENCH 1: Novice Low → Novice High
  const [french1] = await db.insert(curriculumPaths).values({
    name: "French 1 - High School",
    description: "Introductory French for beginners. Students develop foundational communication skills through everyday topics including greetings, family, school, food, and leisure activities. Cultural focus on Francophone world.",
    language: "french",
    targetAudience: "High School",
    startLevel: "novice_low",
    endLevel: "novice_high",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  const french1Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: french1.id,
      name: "Unit 1: Bonjour! Greetings & Introductions",
      description: "Basic greetings, introductions, and classroom phrases. Cultural focus: Francophone countries.",
      orderIndex: 1,
      actflLevel: "novice_low",
      culturalTheme: "Francophone World Geography",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 2: Ma Famille - Family & Friends",
      description: "Describing family members and relationships. Cultural focus: French family structure.",
      orderIndex: 2,
      actflLevel: "novice_low",
      culturalTheme: "French Family Life",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 3: L'École - School Life",
      description: "School subjects, schedules, and supplies. Cultural focus: French education system.",
      orderIndex: 3,
      actflLevel: "novice_mid",
      culturalTheme: "Education in France",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 4: Les Loisirs - Hobbies & Pastimes",
      description: "Sports, activities, and free time. Cultural focus: Popular French sports and leisure.",
      orderIndex: 4,
      actflLevel: "novice_mid",
      culturalTheme: "Sports & Recreation",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 5: La Nourriture - Food & Meals",
      description: "Food vocabulary, ordering in cafés, and French dining customs.",
      orderIndex: 5,
      actflLevel: "novice_mid",
      culturalTheme: "French Cuisine & Dining",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 6: Les Vêtements - Clothing & Fashion",
      description: "Clothing items, colors, and shopping. Cultural focus: French fashion culture.",
      orderIndex: 6,
      actflLevel: "novice_high",
      culturalTheme: "Fashion & Style",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 7: La Ville - City & Transportation",
      description: "Places in town, directions, and public transportation. Cultural focus: Parisian life.",
      orderIndex: 7,
      actflLevel: "novice_high",
      culturalTheme: "Urban Life in France",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french1.id,
      name: "Unit 8: Les Vacances - Travel & Vacation",
      description: "Vacation planning, weather, and French holiday destinations.",
      orderIndex: 8,
      actflLevel: "novice_high",
      culturalTheme: "French Tourism",
      estimatedHours: 15,
    },
  ]).returning();

  // French 1, Unit 1 Lessons
  await db.insert(curriculumLessons).values([
    {
      curriculumUnitId: french1Units[0].id,
      name: "Lesson 1: Salutations - Greetings & Farewells",
      description: "Learn basic greetings (Bonjour, Salut) and farewells (Au revoir, À bientôt — see you soon)",
      orderIndex: 1,
      lessonType: "conversation",
      actflLevel: "novice_low",
      conversationTopic: "Greet someone and say goodbye in different contexts (formal/informal, time of day)",
      conversationPrompt: "You are a friendly French speaker meeting a student for the first time. Practice basic greetings appropriate for different contexts. Keep responses simple and encourage repetition. Use 'tu' and 'vous' appropriately.",
      objectives: ["I can greet someone", "I can say goodbye", "I can ask how someone is"],
      estimatedMinutes: 30,
    },
    {
      curriculumUnitId: french1Units[0].id,
      name: "Lesson 2: Présentations - Introducing Yourself",
      description: "Learn to say your name, ask someone's name using 'Je m'appelle...' and 'Comment tu t'appelles?'",
      orderIndex: 2,
      lessonType: "conversation",
      actflLevel: "novice_low",
      conversationTopic: "Introduce yourself and ask for someone's name",
      conversationPrompt: "You are a French-speaking student meeting a new classmate. Help them practice introductions. Use simple present tense (je m'appelle, tu t'appelles). Model proper pronunciation of nasal sounds.",
      objectives: ["I can introduce myself", "I can ask someone's name", "I can respond to an introduction"],
      estimatedMinutes: 30,
    },
    {
      curriculumUnitId: french1Units[0].id,
      name: "Lesson 3: Les Nombres - Numbers 0-20",
      description: "Count from 0 to 20, ask and tell age using 'J'ai...ans'",
      orderIndex: 3,
      lessonType: "vocabulary",
      actflLevel: "novice_low",
      conversationTopic: "Practice numbers by asking and answering age and simple counting",
      conversationPrompt: "You are a French speaker helping a student practice numbers. Ask their age (Tu as quel âge?) and practice counting. Pay special attention to pronunciation of numbers like six, huit, dix.",
      objectives: ["I can count to 20", "I can tell my age", "I can ask someone's age"],
      estimatedMinutes: 25,
    },
  ]);

  console.log("✅ French 1 curriculum seeded");

  // FRENCH 2: Novice High → Intermediate Low
  const [french2] = await db.insert(curriculumPaths).values({
    name: "French 2 - High School",
    description: "Continuing French study with focus on past tenses, daily routines, health, technology, and Francophone culture. Students develop intermediate-level communication skills across all modes.",
    language: "french",
    targetAudience: "High School",
    startLevel: "novice_high",
    endLevel: "intermediate_low",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  const french2Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: french2.id,
      name: "Unit 1: La Routine Quotidienne - Daily Routines",
      description: "Review and daily routines using reflexive verbs (se lever, se coucher, etc.)",
      orderIndex: 1,
      actflLevel: "novice_high",
      culturalTheme: "Daily Life in France",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french2.id,
      name: "Unit 2: La Santé - Health & Wellness",
      description: "Body parts, illnesses, medical visits, and healthy living vocabulary.",
      orderIndex: 2,
      actflLevel: "intermediate_low",
      culturalTheme: "French Healthcare",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french2.id,
      name: "Unit 3: Le Passé - Past Tense Narratives",
      description: "Passé composé and imparfait for telling stories and describing past events.",
      orderIndex: 3,
      actflLevel: "intermediate_low",
      culturalTheme: "Historical Events",
      estimatedHours: 20,
    },
    {
      curriculumPathId: french2.id,
      name: "Unit 4: La Technologie - Technology & Media",
      description: "Technology vocabulary, social media, and digital communication in French.",
      orderIndex: 4,
      actflLevel: "intermediate_low",
      culturalTheme: "Modern French Media",
      estimatedHours: 15,
    },
    {
      curriculumPathId: french2.id,
      name: "Unit 5: Francophone Cultures",
      description: "Exploring French-speaking regions: Quebec, Africa, Caribbean, Belgium, Switzerland.",
      orderIndex: 5,
      actflLevel: "intermediate_low",
      culturalTheme: "Francophone Diversity",
      estimatedHours: 15,
    },
  ]).returning();

  console.log("✅ French 2 curriculum seeded");

  // FRENCH 3: Intermediate Low → Intermediate Mid
  const [french3] = await db.insert(curriculumPaths).values({
    name: "French 3 - High School",
    description: "Advanced intermediate French exploring French and Francophone arts, literature, history, social issues, and global themes. Emphasis on cultural comparisons and extended discourse.",
    language: "french",
    targetAudience: "High School",
    startLevel: "intermediate_low",
    endLevel: "intermediate_mid",
    estimatedHours: 120,
    isPublished: true,
  }).returning();

  const french3Units = await db.insert(curriculumUnits).values([
    {
      curriculumPathId: french3.id,
      name: "Unit 1: Arts & Culture Française",
      description: "French art, music, cinema, and literature from classical to contemporary.",
      orderIndex: 1,
      actflLevel: "intermediate_low",
      culturalTheme: "French Arts & Culture",
      estimatedHours: 20,
    },
    {
      curriculumPathId: french3.id,
      name: "Unit 2: Histoire & Société",
      description: "French history, revolutions, and societal changes. Cultural comparisons.",
      orderIndex: 2,
      actflLevel: "intermediate_mid",
      culturalTheme: "French History",
      estimatedHours: 20,
    },
    {
      curriculumPathId: french3.id,
      name: "Unit 3: Défis Contemporains",
      description: "Contemporary issues: immigration, environment, social justice in Francophone world.",
      orderIndex: 3,
      actflLevel: "intermediate_mid",
      culturalTheme: "Social Issues",
      estimatedHours: 20,
    },
    {
      curriculumPathId: french3.id,
      name: "Unit 4: Le Futur - Future Plans & Aspirations",
      description: "Future tense, conditional, career planning, and global citizenship.",
      orderIndex: 4,
      actflLevel: "intermediate_mid",
      culturalTheme: "Future Perspectives",
      estimatedHours: 20,
    },
  ]).returning();

  console.log("✅ French 3 curriculum seeded");

  console.log("\n🎉 All curriculum paths seeded successfully!");
  console.log("📚 Total paths created: 7 (Spanish 1-4, French 1-3)");
  console.log("📖 Total estimated hours: 840 hours of instruction");
  console.log("✨ All content aligned with ACTFL World-Readiness Standards");
}

// Run seed if called directly
if (isDirectCliInvocation("curriculum-seed.ts")) {
  seedCurriculum()
    .then(() => {
      console.log("✅ Curriculum seeding complete!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Error seeding curriculum:", error);
      process.exit(1);
    });
}
