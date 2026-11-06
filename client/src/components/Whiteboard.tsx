/**
 * Whiteboard - Tutor-controlled visual teaching aid
 * 
 * Philosophy: "We provide tools, the tutor teaches"
 * The AI tutor decides WHEN and WHAT to display - students don't toggle this.
 * 
 * Phase 2 Extensions:
 * - Image items with visual vocabulary
 * - Drill items with interactive exercises
 * - Pronunciation feedback with score display
 * 
 * Behavior:
 * - Content persists until tutor explicitly sends [CLEAR]
 * - Multiple items stack vertically (new items appear at bottom)
 * - Each item type has its own visual treatment
 * - Mobile: Overlay at bottom of screen (above subtitles)
 * - Desktop: Same positioning, larger text
 */

import { motion, AnimatePresence } from "framer-motion";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { 
  Pencil, 
  Volume2, 
  ArrowLeftRight, 
  X, 
  ImageIcon, 
  Mic, 
  CheckCircle2, 
  XCircle,
  Loader2,
  Star,
  Trophy,
  Target,
  BookOpen,
  Table2,
  Languages,
  PenTool,
  Network,
  Link2,
  RotateCcw,
  Globe,
  Utensils,
  HandMetal,
  Calendar,
  Users,
  Play,
  Pause,
  Square,
  MapPin,
  Sparkles,
  ListChecks,
  RefreshCw,
  AlertTriangle,
  Clock,
  TrendingUp,
  HelpCircle,
  Type,
  Headphones,
  MessageSquare,
  MessageCircle,
  User,
  GraduationCap,
  ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { synthesizeSpeech } from "@/lib/restVoiceApi";
import type HanziWriter from "hanzi-writer";
import type { 
  WhiteboardItem, 
  WhiteboardItemType,
  WriteItem,
  WriteItemSize,
  ImageItem,
  ComparisonItem,
  DrillItem,
  PronunciationItem,
  ContextItem,
  GrammarTableItem,
  ReadingItem,
  StrokeItem,
  WordMapItem,
  CultureItem,
  PlayItem,
  ScenarioItem,
  SummaryItem,
  ErrorPatternsItem,
  VocabularyTimelineItem,
  TextInputItem,
  DrillState,
  MatchPair,
  DialogueItem,
  DialogueLine,
  SentenceTableItem,
  TextbookSearchItem,
  TextbookPageItem,
} from "@shared/whiteboard-types";
import { isComparisonItem, isImageItem, isDrillItem, isPronunciationItem, isContextItem, isGrammarTableItem, isReadingItem, isStrokeItem, isToneItem, isWordMapItem, isCultureItem, isPlayItem, isScenarioItem, isSummaryItem, isErrorPatternsItem, isVocabularyTimelineItem, isTextInputItem, isDialogueItem, isSceneCanvasItem, isSentenceTableItem, isTextbookSearchItem, isTextbookPageItem, isTeachingCardItem, isVocabCardItem, isWordEchoItem, isMatchingDrill, isFillBlankDrill, isSentenceOrderDrill, isMultipleChoiceDrill, isTrueFalseDrill, isConjugationDrill, isDictationDrill, isSpeakDrill, isCognateMatchDrill, isFalseFriendTrapDrill, getDrillInstructions, isDailyPlanItem } from "@shared/whiteboard-types";
import type { DailyPlanItem, DailyPlanAgendaItem, TeachingCardItem, VocabCardItem } from "@shared/whiteboard-types";
import { SceneCanvas } from "@/components/SceneCanvas";
import type { CognatePair, FalseFriendOption } from "@shared/whiteboard-types";
import type { ToneItem } from "@shared/whiteboard-types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { GripVertical, PenLine, Send, ClipboardList, Zap, CalendarDays, ChevronRight } from "lucide-react";

interface WhiteboardProps {
  items: WhiteboardItem[];
  onClear?: () => void;
  onDrillResponse?: (drillId: string, response: string) => void;
  onDrillStart?: (drillId: string) => void;
  onDrillComplete?: (drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string) => void;
  onTextInputSubmit?: (itemId: string, response: string) => void;
  language?: string;
}

const getItemIcon = (type: WhiteboardItemType) => {
  switch (type) {
    case "write":
      return <Pencil className="h-4 w-4" />;
    case "phonetic":
      return <Volume2 className="h-4 w-4" />;
    case "compare":
      return <ArrowLeftRight className="h-4 w-4" />;
    case "image":
      return <ImageIcon className="h-4 w-4" />;
    case "drill":
      return <Target className="h-4 w-4" />;
    case "pronunciation":
      return <Mic className="h-4 w-4" />;
    case "context":
      return <BookOpen className="h-4 w-4" />;
    case "grammar_table":
      return <Table2 className="h-4 w-4" />;
    case "reading":
      return <Languages className="h-4 w-4" />;
    case "stroke":
      return <PenTool className="h-4 w-4" />;
    case "tone":
      return <TrendingUp className="h-4 w-4" />;
    case "word_map":
      return <Network className="h-4 w-4" />;
    case "culture":
      return <Globe className="h-4 w-4" />;
    case "play":
      return <Volume2 className="h-4 w-4" />;
    case "scenario":
      return <MapPin className="h-4 w-4" />;
    case "summary":
      return <ListChecks className="h-4 w-4" />;
    case "error_patterns":
      return <AlertTriangle className="h-4 w-4" />;
    case "vocabulary_timeline":
      return <TrendingUp className="h-4 w-4" />;
    case "text_input":
      return <PenLine className="h-4 w-4" />;
    case "sentence_table":
      return <Table2 className="h-4 w-4" />;
    case "textbook_search":
      return <BookOpen className="h-4 w-4" />;
    default:
      return null;
  }
};

const getItemStyle = (type: WhiteboardItemType): string => {
  switch (type) {
    case "write":
      return "bg-primary/10 border-primary/30 text-foreground";
    case "phonetic":
      return "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300 font-mono";
    case "compare":
      return "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300";
    case "image":
      return "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
    case "drill":
      return "bg-violet-500/10 border-violet-500/30 text-violet-700 dark:text-violet-300";
    case "pronunciation":
      return "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300";
    case "context":
      return "bg-cyan-500/10 border-cyan-500/30 text-cyan-700 dark:text-cyan-300";
    case "grammar_table":
      return "bg-indigo-500/10 border-indigo-500/30 text-indigo-700 dark:text-indigo-300";
    case "reading":
      return "bg-pink-500/10 border-pink-500/30 text-pink-700 dark:text-pink-300";
    case "stroke":
      return "bg-orange-500/10 border-orange-500/30 text-orange-700 dark:text-orange-300";
    case "tone":
      return "bg-fuchsia-500/10 border-fuchsia-500/30 text-fuchsia-700 dark:text-fuchsia-300";
    case "word_map":
      return "bg-teal-500/10 border-teal-500/30 text-teal-700 dark:text-teal-300";
    case "culture":
      return "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300";
    case "play":
      return "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300";
    case "scenario":
      return "bg-purple-500/10 border-purple-500/30 text-purple-700 dark:text-purple-300";
    case "summary":
      return "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
    case "error_patterns":
      return "bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300";
    case "vocabulary_timeline":
      return "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300";
    case "text_input":
      return "bg-lime-500/10 border-lime-500/30 text-lime-700 dark:text-lime-300";
    case "sentence_table":
      return "bg-indigo-500/10 border-indigo-500/30 text-indigo-700 dark:text-indigo-300";
    case "textbook_search":
      return "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300";
    default:
      return "bg-muted border-border text-foreground";
  }
};

const getScoreColor = (score: number): string => {
  if (score >= 90) return "text-green-600 dark:text-green-400";
  if (score >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 70) return "text-yellow-600 dark:text-yellow-400";
  if (score >= 60) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
};

const getScoreIcon = (score: number) => {
  if (score >= 90) return <Trophy className="h-5 w-5 text-yellow-500" />;
  if (score >= 80) return <Star className="h-5 w-5 text-emerald-500" />;
  if (score >= 70) return <CheckCircle2 className="h-5 w-5 text-blue-500" />;
  return <Target className="h-5 w-5 text-orange-500" />;
};

const getDrillStateIcon = (state: DrillState) => {
  switch (state) {
    case "waiting":
      return <Mic className="h-5 w-5 animate-pulse" />;
    case "listening":
      return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;
    case "evaluating":
      return <Loader2 className="h-5 w-5 animate-spin text-violet-500" />;
    case "complete":
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    default:
      return null;
  }
};

interface ImageItemDisplayProps {
  item: ImageItem;
  index: number;
}

const ImageItemDisplay = ({ item, index }: ImageItemDisplayProps) => {
  const { data } = item;
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // labelMode is set by Daniela — students have no control over labels.
  // 'teach'  → show target word + native translation (both labels — introducing)
  // 'target' → show native translation only (hint toward the target language — student produces target word)
  // 'quiz'   → image only — no labels, student must produce the target word unprompted
  const labelMode = data.labelMode ?? 'teach';
  const showWord = labelMode === 'teach';
  const showTranslation = (labelMode === 'teach' || labelMode === 'target') && !!data.translation;

  // Multi-subject: when labels array is present, use chips instead of single header
  const multiLabels = data.labels && data.labels.length > 0 ? data.labels : null;
  // For multi-subject chips, only render if labelMode is not 'quiz'
  const showChips = multiLabels !== null && labelMode !== 'quiz';
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-2 p-4 rounded-lg border bg-emerald-500/10 border-emerald-500/30"
      data-testid={`whiteboard-item-image-${index}`}
    >
      {/* Single-subject label — only when no labels array */}
      {!multiLabels && showWord && (
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400 opacity-60 shrink-0" />
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold text-emerald-700 dark:text-emerald-300">
              {data.word}
            </span>
            {data.latinScript && (
              <span className="text-[12px] font-medium text-emerald-600/80 dark:text-emerald-400/80 italic">
                {data.latinScript}
              </span>
            )}
            {showTranslation && (
              <span className="text-[11px] text-emerald-600/70 dark:text-emerald-400/70">
                {data.translation}
              </span>
            )}
          </div>
        </div>
      )}
      {!multiLabels && !showWord && showTranslation && (
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400 opacity-60 shrink-0" />
          <span className="text-[13px] text-emerald-600/80 dark:text-emerald-400/80">
            {data.translation}
          </span>
        </div>
      )}
      
      {data.isLoading ? (
        <div className="flex items-center justify-center h-32 bg-muted/50 rounded-lg">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : data.imageUrl ? (
        <div
          className="relative group cursor-zoom-in rounded-lg overflow-hidden"
          onClick={() => setLightboxOpen(true)}
        >
          <img 
            src={data.imageUrl} 
            alt={data.description}
            className="w-full h-32 object-cover"
            data-testid={`image-vocab-${data.word}`}
          />
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 rounded-lg">
            <ZoomIn className="h-7 w-7 text-white drop-shadow" />
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-32 bg-muted/50 rounded-lg text-muted-foreground text-sm">
          Generating image...
        </div>
      )}
      
      {/* Multi-subject chip grid — rendered after image, controlled by labelMode */}
      {showChips && (
        <div className="flex flex-wrap gap-1.5" data-testid={`chips-multi-${index}`}>
          {multiLabels!.map((label, i) => (
            <div
              key={i}
              className="flex flex-col leading-tight px-2 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/20"
              data-testid={`chip-vocab-${label.word}`}
            >
              {/* teach mode: show target word (bold) + latin script + native translation */}
              {labelMode === 'teach' && (
                <span className="text-[12px] font-bold text-emerald-700 dark:text-emerald-300">
                  {label.word}
                </span>
              )}
              {labelMode === 'teach' && label.latinScript && (
                <span className="text-[10px] italic text-emerald-600/80 dark:text-emerald-400/80">
                  {label.latinScript}
                </span>
              )}
              {/* teach + target modes: show native translation */}
              {label.translation && (
                <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                  {label.translation}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {data.description && data.description !== data.word && (
        <span className="text-sm text-muted-foreground italic">
          {data.description}
        </span>
      )}

      {data.imageUrl && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-w-3xl p-0 overflow-hidden bg-black border-0" data-testid="whiteboard-image-lightbox">
            <img
              src={data.imageUrl}
              alt={data.description}
              className="w-full h-auto max-h-[80vh] object-contain"
            />
            {data.description && (
              <p className="text-white/80 text-sm text-center px-4 py-2 bg-black/70">{data.description}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </motion.div>
  );
};

interface ComparisonItemDisplayProps {
  item: ComparisonItem;
  index: number;
}

export const ComparisonItemDisplay = ({ item, index }: ComparisonItemDisplayProps) => {
  const { data } = item;
  const isRTL = data.language === 'arabic';
  const hasBackground = !!data.imageUrl;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col rounded-lg border border-violet-500/30 overflow-hidden"
      data-testid={`whiteboard-item-comparison-${index}`}
    >
      {/* Background image wrapper — DOM text always on top */}
      <div
        className="relative"
        style={hasBackground ? {
          backgroundImage: `url(${data.imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : undefined}
      >
        {/* Dark wash so DOM text stays readable over any background image */}
        {hasBackground && (
          <div className="absolute inset-0 bg-black/55" aria-hidden />
        )}

        {/* Two-column grid — concept labels always DOM text */}
        <div
          className="relative z-10 grid grid-cols-2"
          dir={isRTL ? 'rtl' : 'ltr'}
        >
          {/* Left panel — concept_a */}
          <div className={`p-4 flex flex-col gap-1 ${hasBackground ? 'border-r border-white/20' : 'border-r border-violet-500/20 bg-violet-500/5'}`}>
            <div className={`text-xl font-bold tracking-wide ${hasBackground ? 'text-white drop-shadow' : 'text-violet-700 dark:text-violet-300'}`}>
              {data.concept_a}
            </div>
            {data.a_meaning && (
              <ul className={`flex flex-col gap-0.5 mt-0.5 ${hasBackground ? 'text-white/85' : 'text-violet-600/80 dark:text-violet-400/80'}`}>
                {data.a_meaning.split(',').map((item: string, i: number) => item.trim() && (
                  <li key={i} className="flex items-start gap-1 text-xs font-medium leading-snug">
                    <span className="mt-[3px] shrink-0">•</span>
                    <span>{item.trim()}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.a_example && (
              <div className={`text-xs italic mt-1 ${hasBackground ? 'text-white/70' : 'text-muted-foreground'}`}>
                &ldquo;{data.a_example}&rdquo;
              </div>
            )}
          </div>

          {/* Right panel — concept_b */}
          <div className={`p-4 flex flex-col gap-1 ${hasBackground ? '' : 'bg-amber-500/5'}`}>
            <div className={`text-xl font-bold tracking-wide ${hasBackground ? 'text-white drop-shadow' : 'text-amber-700 dark:text-amber-300'}`}>
              {data.concept_b}
            </div>
            {data.b_meaning && (
              <ul className={`flex flex-col gap-0.5 mt-0.5 ${hasBackground ? 'text-white/85' : 'text-amber-600/80 dark:text-amber-400/80'}`}>
                {data.b_meaning.split(',').map((item: string, i: number) => item.trim() && (
                  <li key={i} className="flex items-start gap-1 text-xs font-medium leading-snug">
                    <span className="mt-[3px] shrink-0">•</span>
                    <span>{item.trim()}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.b_example && (
              <div className={`text-xs italic mt-1 ${hasBackground ? 'text-white/70' : 'text-muted-foreground'}`}>
                &ldquo;{data.b_example}&rdquo;
              </div>
            )}
          </div>
        </div>

        {/* Student error context */}
        {data.student_example && (
          <div className={`relative z-10 px-4 py-2 text-xs border-t ${hasBackground ? 'border-white/20 text-white/70' : 'border-violet-500/20 text-muted-foreground bg-violet-500/5'}`}>
            <span className="opacity-60">You said: </span>
            <span className="italic">&ldquo;{data.student_example}&rdquo;</span>
          </div>
        )}
      </div>
    </motion.div>
  );
};

interface DrillItemDisplayProps {
  item: DrillItem;
  index: number;
  onResponse?: (drillId: string, response: string) => void;
  onStart?: (drillId: string) => void;
  language?: string;
}

const DrillItemDisplay = ({ item, index, onResponse, onStart, language }: DrillItemDisplayProps) => {
  const { data } = item;
  const instructions = getDrillInstructions(data.drillType);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const handlePlayAudio = useCallback(async () => {
    if (isPlaying) return;
    
    try {
      setIsPlaying(true);
      const result = await synthesizeSpeech(data.prompt, language);
      const audioUrl = URL.createObjectURL(result.audioBlob);
      
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      
      audio.onended = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.onerror = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(audioUrl);
      };
      
      await audio.play();
    } catch (error) {
      console.error('[DrillItemDisplay] Failed to play audio:', error);
      setIsPlaying(false);
    }
  }, [data.prompt, language, isPlaying]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-violet-500/10 border-violet-500/30"
      data-testid={`whiteboard-item-drill-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <span className="text-sm font-medium text-violet-700 dark:text-violet-300 uppercase tracking-wide">
            {data.drillType.replace('_', ' ')} Drill
          </span>
        </div>
        {data.drillType === 'repeat' && data.state === 'waiting' ? (
          <button
            onClick={handlePlayAudio}
            disabled={isPlaying}
            className="p-1 rounded-full hover:bg-violet-500/20 transition-colors"
            title="Listen to phrase"
            data-testid={`button-listen-drill-${index}`}
          >
            {isPlaying ? (
              <Loader2 className="h-5 w-5 animate-spin text-violet-500" />
            ) : (
              <Volume2 className="h-5 w-5 text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300" />
            )}
          </button>
        ) : (
          getDrillStateIcon(data.state)
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="text-xl md:text-2xl font-bold text-center py-3 bg-background/50 rounded-lg">
        {data.prompt}
      </div>
      
      {data.state === 'waiting' && onStart && (
        <Button 
          onClick={() => onStart(item.id!)}
          className="w-full"
          variant="outline"
          data-testid={`button-start-drill-${index}`}
        >
          <Mic className="h-4 w-4 mr-2" />
          Start Speaking
        </Button>
      )}
      
      {data.state === 'listening' && (
        <div className="text-center text-sm text-blue-600 dark:text-blue-400 animate-pulse">
          Listening...
        </div>
      )}
      
      {data.state === 'evaluating' && (
        <div className="text-center text-sm text-violet-600 dark:text-violet-400">
          Evaluating your response...
        </div>
      )}
      
      {data.state === 'complete' && (
        <div className="flex flex-col gap-2">
          {data.studentResponse && (
            <div className="text-sm text-muted-foreground">
              You said: <span className="font-medium">{data.studentResponse}</span>
            </div>
          )}
          
          <div className={`flex items-center gap-2 ${data.isCorrect ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
            {data.isCorrect ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <XCircle className="h-5 w-5" />
            )}
            <span className="font-medium">
              {data.isCorrect ? 'Great job!' : 'Keep practicing!'}
            </span>
          </div>
          
          {data.feedback && (
            <p className="text-sm text-muted-foreground">{data.feedback}</p>
          )}
        </div>
      )}
    </motion.div>
  );
};

interface MatchDrillDisplayProps {
  item: DrillItem;
  index: number;
  onMatchComplete?: (drillId: string, success: boolean) => void;
}

const MatchDrillDisplay = ({ item, index, onMatchComplete }: MatchDrillDisplayProps) => {
  const { data } = item;
  const pairs = data.pairs || [];
  const shuffledRightIds = data.shuffledRightIds || [];
  
  const [selectedLeftId, setSelectedLeftId] = useState<string | null>(null);
  const [matchedIds, setMatchedIds] = useState<Set<string>>(new Set());
  const [wrongPair, setWrongPair] = useState<{ leftId: string; rightId: string } | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  
  const isComplete = matchedIds.size === pairs.length;
  const progress = pairs.length > 0 ? (matchedIds.size / pairs.length) * 100 : 0;
  
  const handleLeftClick = useCallback((pairId: string) => {
    if (matchedIds.has(pairId)) return;
    setWrongPair(null);
    setSelectedLeftId(selectedLeftId === pairId ? null : pairId);
  }, [selectedLeftId, matchedIds]);
  
  const handleRightClick = useCallback((pairId: string) => {
    if (!selectedLeftId || matchedIds.has(pairId)) return;
    
    setAttempts(prev => prev + 1);
    
    if (selectedLeftId === pairId) {
      const newMatchedSize = matchedIds.size + 1;
      setMatchedIds(prev => {
        const newSet = new Set(prev);
        newSet.add(pairId);
        return newSet;
      });
      setSelectedLeftId(null);
      setWrongPair(null);
      
      if (newMatchedSize === pairs.length && onMatchComplete) {
        const isPerfect = wrongAttempts === 0;
        onMatchComplete(item.id!, isPerfect);
      }
    } else {
      setWrongAttempts(prev => prev + 1);
      setWrongPair({ leftId: selectedLeftId, rightId: pairId });
      setTimeout(() => setWrongPair(null), 800);
    }
  }, [selectedLeftId, matchedIds, pairs.length, item.id, onMatchComplete, wrongAttempts]);
  
  const handleReset = useCallback(() => {
    setSelectedLeftId(null);
    setMatchedIds(new Set());
    setWrongPair(null);
    setAttempts(0);
    setWrongAttempts(0);
  }, []);
  
  const getPairById = useCallback((id: string) => pairs.find(p => p.id === id), [pairs]);
  
  const sortedRightPairs = useMemo(() => {
    return shuffledRightIds.map(id => getPairById(id)).filter(Boolean) as MatchPair[];
  }, [shuffledRightIds, getPairById]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-cyan-500/10 border-cyan-500/30"
      data-testid={`whiteboard-item-match-drill-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
          <span className="text-sm font-medium text-cyan-700 dark:text-cyan-300 uppercase tracking-wide">
            Match Drill
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isComplete ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <span className="text-xs text-muted-foreground">
              {matchedIds.size}/{pairs.length}
            </span>
          )}
        </div>
      </div>
      
      <p className="text-xs text-muted-foreground">
        Tap an item on the left, then tap its match on the right
      </p>
      
      <Progress value={progress} className="h-1.5" />
      
      {isComplete ? (
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex flex-col items-center gap-3 py-4"
        >
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <Trophy className="h-6 w-6" />
            <span className="text-lg font-bold">All matched!</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Completed in {attempts} {attempts === 1 ? 'attempt' : 'attempts'}
          </p>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-match-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            {pairs.map((pair) => {
              const isMatched = matchedIds.has(pair.id);
              const isSelected = selectedLeftId === pair.id;
              const isWrong = wrongPair?.leftId === pair.id;
              
              return (
                <motion.button
                  key={pair.id}
                  onClick={() => handleLeftClick(pair.id)}
                  disabled={isMatched}
                  animate={isWrong ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.4 }}
                  className={`
                    px-3 py-2 rounded-md text-sm font-medium text-left transition-all
                    ${isMatched 
                      ? 'bg-green-500/20 text-green-700 dark:text-green-300 line-through opacity-60' 
                      : isSelected
                        ? 'bg-cyan-500/30 text-cyan-800 dark:text-cyan-200 ring-2 ring-cyan-500'
                        : isWrong
                          ? 'bg-red-500/20 text-red-700 dark:text-red-300'
                          : 'bg-background/80 hover:bg-cyan-500/15'
                    }
                  `}
                  data-testid={`button-match-left-${pair.id}`}
                >
                  {pair.left}
                </motion.button>
              );
            })}
          </div>
          
          <div className="flex flex-col gap-2">
            {sortedRightPairs.map((pair) => {
              const isMatched = matchedIds.has(pair.id);
              const isWrong = wrongPair?.rightId === pair.id;
              const canSelect = selectedLeftId && !isMatched;
              
              return (
                <motion.button
                  key={pair.id}
                  onClick={() => handleRightClick(pair.id)}
                  disabled={isMatched || !selectedLeftId}
                  animate={isWrong ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.4 }}
                  className={`
                    px-3 py-2 rounded-md text-sm font-medium text-left transition-all
                    ${isMatched 
                      ? 'bg-green-500/20 text-green-700 dark:text-green-300 line-through opacity-60' 
                      : isWrong
                        ? 'bg-red-500/20 text-red-700 dark:text-red-300'
                        : canSelect
                          ? 'bg-background/80 hover:bg-cyan-500/15 cursor-pointer'
                          : 'bg-background/80 opacity-50 cursor-not-allowed'
                    }
                  `}
                  data-testid={`button-match-right-${pair.id}`}
                >
                  {pair.right}
                </motion.button>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
};

interface CognateMatchDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, success: boolean) => void;
}

const CognateMatchDrillDisplay = ({ item, index, onComplete }: CognateMatchDrillDisplayProps) => {
  const { data } = item;
  const cognates = data.cognates || [];
  const shuffledTargets = data.shuffledTargets || cognates.map(c => c.targetWord);
  
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [matchedIds, setMatchedIds] = useState<Set<string>>(new Set());
  const [wrongPair, setWrongPair] = useState<{ sourceId: string; targetWord: string } | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  
  const isComplete = matchedIds.size === cognates.length;
  const progress = cognates.length > 0 ? (matchedIds.size / cognates.length) * 100 : 0;
  
  const handleSourceClick = useCallback((cognateId: string) => {
    if (matchedIds.has(cognateId)) return;
    setWrongPair(null);
    setSelectedSourceId(selectedSourceId === cognateId ? null : cognateId);
  }, [selectedSourceId, matchedIds]);
  
  const handleTargetClick = useCallback((targetWord: string) => {
    if (!selectedSourceId) return;
    
    setAttempts(prev => prev + 1);
    
    const selectedCognate = cognates.find(c => c.id === selectedSourceId);
    if (selectedCognate && selectedCognate.targetWord === targetWord) {
      const newMatchedSize = matchedIds.size + 1;
      setMatchedIds(prev => {
        const newSet = new Set(prev);
        newSet.add(selectedSourceId);
        return newSet;
      });
      setSelectedSourceId(null);
      setWrongPair(null);
      
      if (newMatchedSize === cognates.length && onComplete) {
        const isPerfect = wrongAttempts === 0;
        onComplete(item.id!, isPerfect);
      }
    } else {
      setWrongAttempts(prev => prev + 1);
      setWrongPair({ sourceId: selectedSourceId, targetWord });
      setTimeout(() => setWrongPair(null), 800);
    }
  }, [selectedSourceId, matchedIds, cognates, item.id, onComplete, wrongAttempts]);
  
  const handleReset = useCallback(() => {
    setSelectedSourceId(null);
    setMatchedIds(new Set());
    setWrongPair(null);
    setAttempts(0);
    setWrongAttempts(0);
  }, []);
  
  const isTargetMatched = (targetWord: string) => {
    return cognates.some(c => matchedIds.has(c.id) && c.targetWord === targetWord);
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-indigo-500/10 border-indigo-500/30"
      data-testid={`whiteboard-item-cognate-match-drill-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300 uppercase tracking-wide">
            Cognate Match
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isComplete ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <span className="text-xs text-muted-foreground">
              {matchedIds.size}/{cognates.length}
            </span>
          )}
        </div>
      </div>
      
      <p className="text-xs text-muted-foreground">
        Match English words to their cognates (similar words in the target language)
      </p>
      
      <Progress value={progress} className="h-1.5" />
      
      {isComplete ? (
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex flex-col items-center gap-3 py-4"
        >
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <Trophy className="h-6 w-6" />
            <span className="text-lg font-bold">Cognates mastered!</span>
          </div>
          <p className="text-sm text-muted-foreground text-center">
            Great job recognizing word patterns across languages!
          </p>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-cognate-match-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase">English</span>
            {cognates.map((cognate) => {
              const isMatched = matchedIds.has(cognate.id);
              const isSelected = selectedSourceId === cognate.id;
              const isWrong = wrongPair?.sourceId === cognate.id;
              
              return (
                <motion.button
                  key={cognate.id}
                  onClick={() => handleSourceClick(cognate.id)}
                  disabled={isMatched}
                  animate={isWrong ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.4 }}
                  className={`
                    px-3 py-2 rounded-md text-sm font-medium text-left transition-all
                    ${isMatched 
                      ? 'bg-green-500/20 text-green-700 dark:text-green-300 line-through opacity-60' 
                      : isSelected
                        ? 'bg-indigo-500/30 text-indigo-800 dark:text-indigo-200 ring-2 ring-indigo-500'
                        : isWrong
                          ? 'bg-red-500/20 text-red-700 dark:text-red-300'
                          : 'bg-background/80 hover:bg-indigo-500/15'
                    }
                  `}
                  data-testid={`button-cognate-source-${cognate.id}`}
                >
                  {cognate.sourceWord}
                </motion.button>
              );
            })}
          </div>
          
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase">Target</span>
            {shuffledTargets.map((targetWord, idx) => {
              const isMatched = isTargetMatched(targetWord);
              const isWrong = wrongPair?.targetWord === targetWord;
              const canSelect = selectedSourceId && !isMatched;
              
              return (
                <motion.button
                  key={`${targetWord}-${idx}`}
                  onClick={() => handleTargetClick(targetWord)}
                  disabled={isMatched || !selectedSourceId}
                  animate={isWrong ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.4 }}
                  className={`
                    px-3 py-2 rounded-md text-sm font-medium text-left transition-all
                    ${isMatched 
                      ? 'bg-green-500/20 text-green-700 dark:text-green-300 line-through opacity-60' 
                      : isWrong
                        ? 'bg-red-500/20 text-red-700 dark:text-red-300'
                        : canSelect
                          ? 'bg-background/80 hover:bg-indigo-500/15 cursor-pointer'
                          : 'bg-background/80 opacity-50 cursor-not-allowed'
                    }
                  `}
                  data-testid={`button-cognate-target-${idx}`}
                >
                  {targetWord}
                </motion.button>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
};

interface FalseFriendTrapDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const FalseFriendTrapDrillDisplay = ({ item, index, onComplete }: FalseFriendTrapDrillDisplayProps) => {
  const { data } = item;
  const options = data.falseFriendOptions || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  
  const selectedOption = options.find(o => o.id === selectedId);
  const isCorrect = selectedOption ? !selectedOption.isTrap : null;
  const trapOption = options.find(o => o.isTrap);
  const correctOptions = options.filter(o => !o.isTrap);
  
  const handleSelect = useCallback((optionId: string) => {
    if (isSubmitted) return;
    setSelectedId(optionId);
  }, [isSubmitted]);
  
  const handleSubmit = useCallback(() => {
    if (!selectedId) return;
    setIsSubmitted(true);
    setShowExplanation(true);
    
    if (onComplete) {
      const option = options.find(o => o.id === selectedId);
      const correct = option ? !option.isTrap : false;
      onComplete(item.id!, correct);
    }
  }, [selectedId, options, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setSelectedId(null);
    setIsSubmitted(false);
    setShowExplanation(false);
  }, []);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-amber-500/10 border-amber-500/30"
      data-testid={`whiteboard-item-false-friend-trap-drill-${index}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300 uppercase tracking-wide">
          False Friend Trap
        </span>
      </div>
      
      <p className="text-sm font-medium">{data.prompt}</p>
      <p className="text-xs text-muted-foreground">
        One of these is a false friend - it looks similar but means something different!
      </p>
      
      <div className="flex flex-col gap-2">
        {options.map((option) => {
          const isSelected = selectedId === option.id;
          const showResult = isSubmitted && isSelected;
          const wasCorrectChoice = isSubmitted && !option.isTrap;
          const wasTrap = isSubmitted && option.isTrap;
          
          return (
            <motion.button
              key={option.id}
              onClick={() => handleSelect(option.id)}
              disabled={isSubmitted}
              animate={showResult && option.isTrap ? { x: [-4, 4, -4, 4, 0] } : {}}
              transition={{ duration: 0.4 }}
              className={`
                px-4 py-3 rounded-md text-sm font-medium text-left transition-all flex items-center justify-between
                ${isSubmitted 
                  ? wasTrap
                    ? 'bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/50'
                    : wasCorrectChoice
                      ? 'bg-green-500/20 text-green-700 dark:text-green-300 border border-green-500/50'
                      : 'bg-background/80 opacity-60'
                  : isSelected
                    ? 'bg-amber-500/30 text-amber-800 dark:text-amber-200 ring-2 ring-amber-500'
                    : 'bg-background/80 hover:bg-amber-500/15'
                }
              `}
              data-testid={`button-false-friend-option-${option.id}`}
            >
              <span>{option.word}</span>
              {isSubmitted && (
                <span className="flex items-center gap-1">
                  {wasTrap ? (
                    <>
                      <XCircle className="h-4 w-4" />
                      <span className="text-xs">False friend!</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="text-xs">True cognate</span>
                    </>
                  )}
                </span>
              )}
            </motion.button>
          );
        })}
      </div>
      
      {!isSubmitted && selectedId && (
        <Button
          onClick={handleSubmit}
          className="w-full"
          data-testid={`button-submit-false-friend-${index}`}
        >
          Check Answer
        </Button>
      )}
      
      {showExplanation && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className={`p-3 rounded-md ${isCorrect ? 'bg-green-500/10' : 'bg-amber-500/10'}`}
        >
          <div className="flex items-center gap-2 mb-2">
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                <span className="font-medium text-green-700 dark:text-green-300">Correct! You avoided the trap!</span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                <span className="font-medium text-amber-700 dark:text-amber-300">Oops! You fell for the false friend!</span>
              </>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {data.trapExplanation || `"${trapOption?.word}" is a false friend - it looks similar but has a different meaning!`}
          </p>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid={`button-reset-false-friend-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
};

interface FillBlankDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const FillBlankDrillDisplay = ({ item, index, onComplete }: FillBlankDrillDisplayProps) => {
  const { data } = item;
  const [selectedAnswer, setSelectedAnswer] = useState<string>('');
  const [textInput, setTextInput] = useState<string>('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  
  const hasOptions = data.options && data.options.length > 0;
  const instructions = getDrillInstructions(data.drillType);
  
  const handleSubmit = useCallback(() => {
    const answer = hasOptions ? selectedAnswer : textInput.trim();
    const correct = answer.toLowerCase() === data.correctAnswer?.toLowerCase();
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [selectedAnswer, textInput, hasOptions, data.correctAnswer, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setSelectedAnswer('');
    setTextInput('');
    setIsSubmitted(false);
    setIsCorrect(null);
  }, []);
  
  const renderBlankedText = () => {
    const text = data.blankedText || data.prompt;
    const parts = text.split('___');
    
    return (
      <div className="text-lg md:text-xl font-medium text-center py-3 bg-background/50 rounded-lg flex flex-wrap items-center justify-center gap-1">
        {parts.map((part, i) => (
          <span key={i}>
            {part}
            {i < parts.length - 1 && (
              <span className={`inline-block min-w-[80px] mx-1 px-2 py-1 rounded border-2 border-dashed ${
                isSubmitted 
                  ? isCorrect 
                    ? 'border-green-500 bg-green-500/10 text-green-700 dark:text-green-300'
                    : 'border-red-500 bg-red-500/10 text-red-700 dark:text-red-300'
                  : 'border-violet-500/50'
              }`}>
                {isSubmitted 
                  ? (hasOptions ? selectedAnswer : textInput) || '___'
                  : hasOptions 
                    ? (selectedAnswer || '___')
                    : (textInput || '___')
                }
              </span>
            )}
          </span>
        ))}
      </div>
    );
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-violet-500/10 border-violet-500/30"
      data-testid={`whiteboard-item-fill-blank-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <span className="text-sm font-medium text-violet-700 dark:text-violet-300 uppercase tracking-wide">
            Fill in the Blank
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      {renderBlankedText()}
      
      {!isSubmitted ? (
        <div className="flex flex-col gap-3">
          {hasOptions ? (
            <Select value={selectedAnswer} onValueChange={setSelectedAnswer}>
              <SelectTrigger className="w-full" data-testid={`select-fill-blank-${index}`}>
                <SelectValue placeholder="Choose an answer..." />
              </SelectTrigger>
              <SelectContent>
                {data.options?.map((option, i) => (
                  <SelectItem key={i} value={option} data-testid={`option-${option}`}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type your answer..."
              className="text-center"
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              data-testid={`input-fill-blank-${index}`}
            />
          )}
          
          <Button
            onClick={handleSubmit}
            disabled={hasOptions ? !selectedAnswer : !textInput.trim()}
            className="w-full"
            data-testid={`button-submit-fill-blank-${index}`}
          >
            <CheckCircle2 className="h-4 w-4 mr-2" />
            Check Answer
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Correct!</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5" />
                <span className="font-medium">
                  The answer is: <strong>{data.correctAnswer}</strong>
                </span>
              </>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-fill-blank-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface SentenceOrderDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const SentenceOrderDrillDisplay = ({ item, index, onComplete }: SentenceOrderDrillDisplayProps) => {
  const { data } = item;
  const [currentOrder, setCurrentOrder] = useState<string[]>(data.currentOrder || data.words || []);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  
  const instructions = getDrillInstructions(data.drillType);
  
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);
  
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    
    setCurrentOrder(prev => {
      const newOrder = [...prev];
      const draggedItem = newOrder[draggedIndex];
      newOrder.splice(draggedIndex, 1);
      newOrder.splice(index, 0, draggedItem);
      return newOrder;
    });
    setDraggedIndex(index);
  }, [draggedIndex]);
  
  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
  }, []);
  
  const moveWord = useCallback((fromIndex: number, direction: 'left' | 'right') => {
    const toIndex = direction === 'left' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= currentOrder.length) return;
    
    setCurrentOrder(prev => {
      const newOrder = [...prev];
      [newOrder[fromIndex], newOrder[toIndex]] = [newOrder[toIndex], newOrder[fromIndex]];
      return newOrder;
    });
  }, [currentOrder.length]);
  
  const handleSubmit = useCallback(() => {
    const correct = JSON.stringify(currentOrder) === JSON.stringify(data.correctOrder);
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [currentOrder, data.correctOrder, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setCurrentOrder(data.words || []);
    setIsSubmitted(false);
    setIsCorrect(null);
  }, [data.words]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-indigo-500/10 border-indigo-500/30"
      data-testid={`whiteboard-item-sentence-order-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300 uppercase tracking-wide">
            Sentence Builder
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="flex flex-wrap gap-2 p-3 bg-background/50 rounded-lg min-h-[60px] justify-center">
        {currentOrder.map((word, i) => (
          <motion.div
            key={`${word}-${i}`}
            draggable={!isSubmitted}
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            layout
            className={`
              flex items-center gap-1 px-3 py-2 rounded-md text-sm font-medium
              ${isSubmitted 
                ? isCorrect
                  ? 'bg-green-500/20 text-green-700 dark:text-green-300 border border-green-500/30'
                  : 'bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/30'
                : draggedIndex === i
                  ? 'bg-indigo-500/30 text-indigo-800 dark:text-indigo-200 ring-2 ring-indigo-500 cursor-grabbing'
                  : 'bg-background border border-indigo-500/30 cursor-grab hover:bg-indigo-500/10'
              }
            `}
            data-testid={`word-${i}-${word}`}
          >
            {!isSubmitted && (
              <GripVertical className="h-3 w-3 text-muted-foreground" />
            )}
            {word}
          </motion.div>
        ))}
      </div>
      
      {!isSubmitted && (
        <div className="flex flex-wrap gap-1 justify-center text-xs text-muted-foreground">
          <span>Tap arrows or drag to reorder:</span>
          <div className="flex gap-1">
            {currentOrder.map((_, i) => (
              <div key={i} className="flex gap-0.5">
                <button
                  onClick={() => moveWord(i, 'left')}
                  disabled={i === 0}
                  className="px-1 py-0.5 rounded text-xs hover:bg-muted disabled:opacity-30"
                  data-testid={`button-move-left-${i}`}
                >
                  ←
                </button>
                <span className="text-muted-foreground/50">{i + 1}</span>
                <button
                  onClick={() => moveWord(i, 'right')}
                  disabled={i === currentOrder.length - 1}
                  className="px-1 py-0.5 rounded text-xs hover:bg-muted disabled:opacity-30"
                  data-testid={`button-move-right-${i}`}
                >
                  →
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {!isSubmitted ? (
        <Button
          onClick={handleSubmit}
          className="w-full"
          data-testid={`button-submit-sentence-order-${index}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          Check Order
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Perfect order!</span>
              </>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">Not quite right</span>
                </div>
                <p className="text-sm">
                  Correct order: <strong>{data.correctOrder?.join(' ')}</strong>
                </p>
              </div>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-sentence-order-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface MultipleChoiceDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const MultipleChoiceDrillDisplay = ({ item, index, onComplete }: MultipleChoiceDrillDisplayProps) => {
  const { data } = item;
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  
  const choices = data.choices || [];
  const instructions = getDrillInstructions(data.drillType);
  const letters = ['A', 'B', 'C', 'D'];
  
  const handleSubmit = useCallback(() => {
    if (selectedChoice === null) return;
    const correct = selectedChoice === data.correctChoice;
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [selectedChoice, data.correctChoice, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setSelectedChoice(null);
    setIsSubmitted(false);
    setIsCorrect(null);
  }, []);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-blue-500/10 border-blue-500/30"
      data-testid={`whiteboard-item-multiple-choice-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium text-blue-700 dark:text-blue-300 uppercase tracking-wide">
            Multiple Choice
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="text-lg font-medium text-center py-3 bg-background/50 rounded-lg">
        {data.prompt}
      </div>
      
      <div className="flex flex-col gap-2">
        {choices.map((choice, i) => {
          const isSelected = selectedChoice === i;
          const isCorrectAnswer = i === data.correctChoice;
          const showCorrect = isSubmitted && isCorrectAnswer;
          const showWrong = isSubmitted && isSelected && !isCorrectAnswer;
          
          return (
            <button
              key={i}
              onClick={() => !isSubmitted && setSelectedChoice(i)}
              disabled={isSubmitted}
              className={`
                flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all
                ${showCorrect 
                  ? 'bg-green-500/20 border-green-500 text-green-700 dark:text-green-300'
                  : showWrong
                    ? 'bg-red-500/20 border-red-500 text-red-700 dark:text-red-300'
                    : isSelected
                      ? 'bg-blue-500/20 border-blue-500 text-blue-700 dark:text-blue-300'
                      : 'bg-background/80 border-border hover:bg-blue-500/10'
                }
                ${isSubmitted ? 'cursor-default' : 'cursor-pointer'}
              `}
              data-testid={`button-choice-${letters[i]}-${index}`}
            >
              <span className={`
                flex items-center justify-center w-6 h-6 rounded-full text-sm font-bold
                ${isSelected || showCorrect || showWrong 
                  ? 'bg-current/20' 
                  : 'bg-muted'
                }
              `}>
                {letters[i]}
              </span>
              <span className="flex-1">{choice}</span>
              {showCorrect && <CheckCircle2 className="h-5 w-5 text-green-500" />}
              {showWrong && <XCircle className="h-5 w-5 text-red-500" />}
            </button>
          );
        })}
      </div>
      
      {!isSubmitted ? (
        <Button
          onClick={handleSubmit}
          disabled={selectedChoice === null}
          className="w-full"
          data-testid={`button-submit-multiple-choice-${index}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          Check Answer
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Correct!</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5" />
                <span className="font-medium">
                  The correct answer is {letters[data.correctChoice || 0]}
                </span>
              </>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-multiple-choice-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface TrueFalseDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const TrueFalseDrillDisplay = ({ item, index, onComplete }: TrueFalseDrillDisplayProps) => {
  const { data } = item;
  const [selectedAnswer, setSelectedAnswer] = useState<boolean | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  
  const instructions = getDrillInstructions(data.drillType);
  
  const handleSubmit = useCallback(() => {
    if (selectedAnswer === null) return;
    const correct = selectedAnswer === data.isTrue;
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [selectedAnswer, data.isTrue, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setSelectedAnswer(null);
    setIsSubmitted(false);
    setIsCorrect(null);
  }, []);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-amber-500/10 border-amber-500/30"
      data-testid={`whiteboard-item-true-false-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HelpCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="text-sm font-medium text-amber-700 dark:text-amber-300 uppercase tracking-wide">
            True or False
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="text-lg font-medium text-center py-4 px-3 bg-background/50 rounded-lg italic">
        "{data.statement || data.prompt}"
      </div>
      
      <div className="flex gap-3">
        <button
          onClick={() => !isSubmitted && setSelectedAnswer(true)}
          disabled={isSubmitted}
          className={`
            flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border text-lg font-medium transition-all
            ${isSubmitted && data.isTrue
              ? 'bg-green-500/20 border-green-500 text-green-700 dark:text-green-300'
              : isSubmitted && selectedAnswer === true && !data.isTrue
                ? 'bg-red-500/20 border-red-500 text-red-700 dark:text-red-300'
                : selectedAnswer === true
                  ? 'bg-amber-500/20 border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'bg-background/80 border-border hover:bg-amber-500/10'
            }
            ${isSubmitted ? 'cursor-default' : 'cursor-pointer'}
          `}
          data-testid={`button-true-${index}`}
        >
          <CheckCircle2 className="h-5 w-5" />
          True
        </button>
        <button
          onClick={() => !isSubmitted && setSelectedAnswer(false)}
          disabled={isSubmitted}
          className={`
            flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border text-lg font-medium transition-all
            ${isSubmitted && !data.isTrue
              ? 'bg-green-500/20 border-green-500 text-green-700 dark:text-green-300'
              : isSubmitted && selectedAnswer === false && data.isTrue
                ? 'bg-red-500/20 border-red-500 text-red-700 dark:text-red-300'
                : selectedAnswer === false
                  ? 'bg-amber-500/20 border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'bg-background/80 border-border hover:bg-amber-500/10'
            }
            ${isSubmitted ? 'cursor-default' : 'cursor-pointer'}
          `}
          data-testid={`button-false-${index}`}
        >
          <XCircle className="h-5 w-5" />
          False
        </button>
      </div>
      
      {!isSubmitted ? (
        <Button
          onClick={handleSubmit}
          disabled={selectedAnswer === null}
          className="w-full"
          data-testid={`button-submit-true-false-${index}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          Check Answer
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Correct!</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5" />
                <span className="font-medium">
                  The statement is {data.isTrue ? 'True' : 'False'}
                </span>
              </>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-true-false-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface ConjugationDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const ConjugationDrillDisplay = ({ item, index, onComplete }: ConjugationDrillDisplayProps) => {
  const { data } = item;
  const [userInput, setUserInput] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  
  const instructions = getDrillInstructions(data.drillType);
  
  const handleSubmit = useCallback(() => {
    const correct = userInput.trim().toLowerCase() === data.conjugatedForm?.toLowerCase();
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [userInput, data.conjugatedForm, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setUserInput('');
    setIsSubmitted(false);
    setIsCorrect(null);
  }, []);
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSubmitted && userInput.trim()) {
      handleSubmit();
    }
  }, [handleSubmit, isSubmitted, userInput]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-emerald-500/10 border-emerald-500/30"
      data-testid={`whiteboard-item-conjugation-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Type className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
            Verb Conjugation
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="bg-background/50 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-center gap-2 text-lg">
          <span className="font-bold text-emerald-600 dark:text-emerald-400">{data.verb}</span>
          <span className="text-muted-foreground">in</span>
          <span className="px-2 py-1 bg-muted rounded text-sm">{data.tense}</span>
          <span className="text-muted-foreground">for</span>
          <span className="font-bold">{data.subject}</span>
        </div>
      </div>
      
      <div className="flex gap-2">
        <Input
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSubmitted}
          placeholder="Type the conjugated form..."
          className={`
            flex-1 text-center text-lg
            ${isSubmitted 
              ? isCorrect
                ? 'border-green-500 bg-green-500/10'
                : 'border-red-500 bg-red-500/10'
              : ''
            }
          `}
          data-testid={`input-conjugation-${index}`}
        />
      </div>
      
      {!isSubmitted ? (
        <Button
          onClick={handleSubmit}
          disabled={!userInput.trim()}
          className="w-full"
          data-testid={`button-submit-conjugation-${index}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          Check Answer
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Correct!</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5" />
                <span className="font-medium">
                  The correct form is: <strong>{data.conjugatedForm}</strong>
                </span>
              </>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-conjugation-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface DictationDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const DictationDrillDisplay = ({ item, index, onComplete }: DictationDrillDisplayProps) => {
  const { data } = item;
  const [userInput, setUserInput] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  const instructions = getDrillInstructions(data.drillType);
  
  const handlePlayAudio = useCallback(async () => {
    if (isPlaying) return;
    setIsPlaying(true);
    
    try {
      // Use pre-generated audio URL or synthesize on demand
      if (data.audioUrl) {
        if (!audioRef.current) {
          audioRef.current = new Audio(data.audioUrl);
        }
        audioRef.current.onended = () => setIsPlaying(false);
        audioRef.current.onerror = () => setIsPlaying(false);
        await audioRef.current.play();
      } else if (data.audioText) {
        // Synthesize on demand using TTS
        const result = await synthesizeSpeech(data.audioText, 'normal');
        const audioUrl = URL.createObjectURL(result.audioBlob);
        audioRef.current = new Audio(audioUrl);
        audioRef.current.onended = () => {
          URL.revokeObjectURL(audioUrl);
          setIsPlaying(false);
        };
        audioRef.current.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          setIsPlaying(false);
        };
        await audioRef.current.play();
      }
    } catch (err) {
      console.error('[Dictation] Audio playback failed:', err);
      setIsPlaying(false);
    }
  }, [isPlaying, data.audioUrl, data.audioText]);
  
  const handleSubmit = useCallback(() => {
    const normalized = userInput.trim().toLowerCase().replace(/[.,!?]/g, '');
    const expected = (data.audioText || '').trim().toLowerCase().replace(/[.,!?]/g, '');
    const correct = normalized === expected;
    setIsCorrect(correct);
    setIsSubmitted(true);
    if (onComplete) {
      onComplete(item.id!, correct);
    }
  }, [userInput, data.audioText, item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setUserInput('');
    setIsSubmitted(false);
    setIsCorrect(null);
  }, []);
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSubmitted && userInput.trim()) {
      handleSubmit();
    }
  }, [handleSubmit, isSubmitted, userInput]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-cyan-500/10 border-cyan-500/30"
      data-testid={`whiteboard-item-dictation-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Headphones className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
          <span className="text-sm font-medium text-cyan-700 dark:text-cyan-300 uppercase tracking-wide">
            Dictation
          </span>
        </div>
        {isSubmitted && (
          isCorrect 
            ? <CheckCircle2 className="h-5 w-5 text-green-500" />
            : <XCircle className="h-5 w-5 text-red-500" />
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="flex items-center justify-center py-4">
        <Button
          variant="outline"
          size="lg"
          onClick={handlePlayAudio}
          disabled={isPlaying}
          className="gap-2"
          data-testid={`button-play-dictation-${index}`}
        >
          {isPlaying ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Volume2 className="h-5 w-5" />
          )}
          {isPlaying ? 'Playing...' : 'Play Audio'}
        </Button>
      </div>
      
      <Input
        value={userInput}
        onChange={(e) => setUserInput(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isSubmitted}
        placeholder="Type what you hear..."
        className={`
          text-center text-lg
          ${isSubmitted 
            ? isCorrect
              ? 'border-green-500 bg-green-500/10'
              : 'border-red-500 bg-red-500/10'
            : ''
          }
        `}
        data-testid={`input-dictation-${index}`}
      />
      
      {!isSubmitted ? (
        <Button
          onClick={handleSubmit}
          disabled={!userInput.trim()}
          className="w-full"
          data-testid={`button-submit-dictation-${index}`}
        >
          <CheckCircle2 className="h-4 w-4 mr-2" />
          Check Answer
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {isCorrect ? (
              <>
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Correct!</span>
              </>
            ) : (
              <>
                <XCircle className="h-5 w-5" />
                <span className="font-medium">
                  The correct answer is: <strong>{data.audioText}</strong>
                </span>
              </>
            )}
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-dictation-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface SpeakDrillDisplayProps {
  item: DrillItem;
  index: number;
  onComplete?: (drillId: string, isCorrect: boolean) => void;
}

const SpeakDrillDisplay = ({ item, index, onComplete }: SpeakDrillDisplayProps) => {
  const { data } = item;
  const [attempts, setAttempts] = useState(0);
  const [isCompleted, setIsCompleted] = useState(false);
  const [showHint, setShowHint] = useState(false);
  
  const instructions = getDrillInstructions(data.drillType);
  
  const handleAttempt = useCallback(() => {
    setAttempts(prev => prev + 1);
  }, []);
  
  const handleComplete = useCallback(() => {
    setIsCompleted(true);
    if (onComplete) {
      // Speak drills are self-evaluated, so we consider them successful after completion
      onComplete(item.id!, true);
    }
  }, [item.id, onComplete]);
  
  const handleReset = useCallback(() => {
    setAttempts(0);
    setIsCompleted(false);
    setShowHint(false);
  }, []);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-pink-500/10 border-pink-500/30"
      data-testid={`whiteboard-item-speak-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-pink-600 dark:text-pink-400" />
          <span className="text-sm font-medium text-pink-700 dark:text-pink-300 uppercase tracking-wide">
            Speak Aloud
          </span>
        </div>
        {isCompleted && <CheckCircle2 className="h-5 w-5 text-green-500" />}
      </div>
      
      <p className="text-xs text-muted-foreground">{instructions}</p>
      
      <div className="text-xl md:text-2xl font-medium text-center py-4 px-3 bg-background/50 rounded-lg">
        {data.textToSpeak || data.prompt}
      </div>
      
      {data.translationHint && (
        <div className="flex flex-col items-center gap-1">
          {showHint ? (
            <p className="text-sm text-muted-foreground italic">
              Translation: {data.translationHint}
            </p>
          ) : (
            <button
              onClick={() => setShowHint(true)}
              className="text-xs text-pink-600 dark:text-pink-400 hover:underline"
              data-testid={`button-show-hint-${index}`}
            >
              Show translation hint
            </button>
          )}
        </div>
      )}
      
      {attempts > 0 && !isCompleted && (
        <p className="text-xs text-center text-muted-foreground">
          Attempts: {attempts}
        </p>
      )}
      
      {!isCompleted ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleAttempt}
            className="flex-1"
            data-testid={`button-attempt-speak-${index}`}
          >
            <Mic className="h-4 w-4 mr-2" />
            I Practiced
          </Button>
          <Button
            onClick={handleComplete}
            className="flex-1"
            data-testid={`button-complete-speak-${index}`}
          >
            <CheckCircle2 className="h-4 w-4 mr-2" />
            I Got It
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-medium">Great job practicing!</span>
          </div>
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            data-testid={`button-reset-speak-${index}`}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Practice Again
          </Button>
        </div>
      )}
    </motion.div>
  );
};

interface PronunciationItemDisplayProps {
  item: PronunciationItem;
  index: number;
}

const PronunciationItemDisplay = ({ item, index }: PronunciationItemDisplayProps) => {
  const { data } = item;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-rose-500/10 border-rose-500/30"
      data-testid={`whiteboard-item-pronunciation-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <span className="text-sm font-medium text-rose-700 dark:text-rose-300">
            Pronunciation Feedback
          </span>
        </div>
        {getScoreIcon(data.score)}
      </div>
      
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <Progress value={data.score} className="h-2" />
        </div>
        <span className={`text-2xl font-bold ${getScoreColor(data.score)}`}>
          {data.score}
        </span>
      </div>
      
      <p className="text-sm">{data.feedback}</p>
      
      {data.strengths.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.strengths.map((strength, i) => (
            <span 
              key={i}
              className="text-xs px-2 py-0.5 bg-green-500/20 text-green-700 dark:text-green-300 rounded-full"
            >
              {strength}
            </span>
          ))}
        </div>
      )}
      
      {data.phoneticIssues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.phoneticIssues.map((issue, i) => (
            <span 
              key={i}
              className="text-xs px-2 py-0.5 bg-orange-500/20 text-orange-700 dark:text-orange-300 rounded-full"
            >
              {issue}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
};

/**
 * Parse markdown-like formatting (inner function - no size tags to prevent recursion)
 * Used for nested content inside size tags like <lg>**bold**</lg>
 */
function parseFormattedTextInner(text: string): JSX.Element[] {
  if (!text) {
    return [<span key={0}></span>];
  }
  
  const elements: JSX.Element[] = [];
  let keyIndex = 0;
  
  const formatRegex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(__(.+?)__)|(\~\~(.+?)\~\~)|(`(.+?)`)/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = formatRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const { elements: plainEls, nextKey } = renderPlainTextWithBreaks(text.slice(lastIndex, match.index), keyIndex);
      elements.push(...plainEls);
      keyIndex = nextKey;
    }
    
    if (match[1]) {
      elements.push(<strong key={keyIndex++} className="font-bold">{match[2]}</strong>);
    } else if (match[3]) {
      elements.push(<em key={keyIndex++} className="italic">{match[4]}</em>);
    } else if (match[5]) {
      elements.push(<span key={keyIndex++} className="underline decoration-2">{match[6]}</span>);
    } else if (match[7]) {
      elements.push(<span key={keyIndex++} className="line-through opacity-60">{match[8]}</span>);
    } else if (match[9]) {
      elements.push(<code key={keyIndex++} className="font-mono bg-muted px-1.5 py-0.5 rounded text-sm">{match[10]}</code>);
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < text.length) {
    const { elements: plainEls, nextKey } = renderPlainTextWithBreaks(text.slice(lastIndex), keyIndex);
    elements.push(...plainEls);
    keyIndex = nextKey;
  }
  
  if (elements.length === 0) {
    const { elements: plainEls } = renderPlainTextWithBreaks(text, 0);
    elements.push(...plainEls);
  }
  
  return elements;
}

/**
 * Parse markdown-like formatting in whiteboard text content
 * Supports: **bold**, *italic*, __underline__, ~~strikethrough~~, `code`
 * Inline sizes: <sm>small</sm>, <lg>large</lg>, <xl>extra large</xl>
 */
function renderPlainTextWithBreaks(text: string, startKey: number): { elements: JSX.Element[]; nextKey: number } {
  const elements: JSX.Element[] = [];
  let k = startKey;
  const parts = text.split('\n');
  parts.forEach((part, i) => {
    if (part) elements.push(<span key={k++}>{part}</span>);
    if (i < parts.length - 1) elements.push(<br key={k++} />);
  });
  return { elements, nextKey: k };
}

function parseFormattedText(text: string): JSX.Element[] {
  if (!text) {
    return [<span key={0}></span>];
  }
  
  const elements: JSX.Element[] = [];
  let keyIndex = 0;
  
  const formatRegex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(__(.+?)__)|(\~\~(.+?)\~\~)|(`(.+?)`)|(<sm>(.+?)<\/sm>)|(<lg>(.+?)<\/lg>)|(<xl>(.+?)<\/xl>)/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = formatRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const { elements: plainEls, nextKey } = renderPlainTextWithBreaks(text.slice(lastIndex, match.index), keyIndex);
      elements.push(...plainEls);
      keyIndex = nextKey;
    }
    
    if (match[1]) {
      elements.push(
        <strong key={keyIndex++} className="font-bold">{match[2]}</strong>
      );
    } else if (match[3]) {
      elements.push(
        <em key={keyIndex++} className="italic">{match[4]}</em>
      );
    } else if (match[5]) {
      elements.push(
        <span key={keyIndex++} className="underline decoration-2">{match[6]}</span>
      );
    } else if (match[7]) {
      elements.push(
        <span key={keyIndex++} className="line-through opacity-60">{match[8]}</span>
      );
    } else if (match[9]) {
      elements.push(
        <code key={keyIndex++} className="font-mono bg-muted px-1.5 py-0.5 rounded text-sm">{match[10]}</code>
      );
    } else if (match[11]) {
      elements.push(
        <span key={keyIndex++} className="text-sm">{parseFormattedTextInner(match[12])}</span>
      );
    } else if (match[13]) {
      elements.push(
        <span key={keyIndex++} className="text-lg">{parseFormattedTextInner(match[14])}</span>
      );
    } else if (match[15]) {
      elements.push(
        <span key={keyIndex++} className="text-xl font-semibold">{parseFormattedTextInner(match[16])}</span>
      );
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  if (lastIndex < text.length) {
    const { elements: plainEls, nextKey } = renderPlainTextWithBreaks(text.slice(lastIndex), keyIndex);
    elements.push(...plainEls);
    keyIndex = nextKey;
  }
  
  if (elements.length === 0) {
    const { elements: plainEls } = renderPlainTextWithBreaks(text, 0);
    elements.push(...plainEls);
  }
  
  return elements;
}

/**
 * Get Tailwind text size class from WriteItemSize
 */
function getTextSizeClass(size?: WriteItemSize): string {
  switch (size) {
    case 'xs': return 'text-xs';
    case 'sm': return 'text-sm';
    case 'base': return 'text-base';
    case 'lg': return 'text-lg';
    case 'xl': return 'text-xl';
    case '2xl': return 'text-2xl';
    case '3xl': return 'text-3xl';
    default: return 'text-lg md:text-xl'; // Default size
  }
}

/**
 * Type guard for WriteItem
 */
function isWriteItem(item: WhiteboardItem): item is WriteItem {
  return item.type === 'write';
}

interface DialogueItemDisplayProps {
  item: DialogueItem;
  index: number;
}

const DialogueItemDisplay = ({ item, index }: DialogueItemDisplayProps) => {
  const { data } = item;
  const lines = data?.lines || [];
  const tutorName = data?.tutorName || 'Daniela';
  const studentName = data?.studentName || 'You';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-2 p-4 rounded-lg border bg-violet-500/10 border-violet-500/30"
      data-testid={`whiteboard-item-dialogue-${index}`}
    >
      {data?.title && (
        <div className="flex items-center gap-2 mb-1">
          <MessageCircle className="h-4 w-4 text-violet-600 dark:text-violet-400 opacity-60" />
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-300">
            {data.title}
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {lines.map((line: DialogueLine, i: number) => {
          const isTutor = line.speaker === 'tutor';
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: isTutor ? -10 : 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.08 }}
              className={`flex items-start gap-2 px-3 py-2 rounded-md ${
                isTutor
                  ? 'bg-violet-500/15 border-l-2 border-violet-500/50'
                  : 'bg-emerald-500/15 border-l-2 border-emerald-500/50'
              }`}
              data-testid={`dialogue-line-${line.speaker}-${i}`}
            >
              <div className={`flex items-center gap-1.5 shrink-0 mt-0.5 ${
                isTutor 
                  ? 'text-violet-600 dark:text-violet-400' 
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}>
                {isTutor 
                  ? <GraduationCap className="h-3.5 w-3.5" /> 
                  : <User className="h-3.5 w-3.5" />
                }
                <span className="text-xs font-bold uppercase tracking-wide">
                  {isTutor ? tutorName : studentName}
                </span>
              </div>
              <span className={`text-base font-medium leading-relaxed ${
                isTutor 
                  ? 'text-violet-800 dark:text-violet-200' 
                  : 'text-emerald-800 dark:text-emerald-200'
              }`}>
                {parseFormattedText(line.text)}
              </span>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
};

interface TextItemDisplayProps {
  item: WhiteboardItem;
  index: number;
}

const TextItemDisplay = ({ item, index }: TextItemDisplayProps) => {
  const icon = getItemIcon(item.type);
  const style = getItemStyle(item.type);
  
  // Get size from WriteItem data if available
  const size = isWriteItem(item) ? item.data?.size : undefined;
  const textSizeClass = getTextSizeClass(size);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className={`flex items-start gap-2 px-4 py-3 rounded-lg border ${style}`}
      data-testid={`whiteboard-item-${item.type}-${index}`}
    >
      {icon && (
        <span className="flex-shrink-0 mt-0.5 opacity-60">
          {icon}
        </span>
      )}
      <div className={`${textSizeClass} font-medium leading-relaxed flex-1`}>
        {parseFormattedText(item.content)}
      </div>
    </motion.div>
  );
};

interface ContextItemDisplayProps {
  item: ContextItem;
  index: number;
}

const ContextItemDisplay = ({ item, index }: ContextItemDisplayProps) => {
  const { data } = item;
  
  const highlightWord = (sentence: string, word: string) => {
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unicodeBoundary = '(?<![\\p{L}\\p{N}])';
    const unicodeBoundaryEnd = '(?![\\p{L}\\p{N}])';
    const regex = new RegExp(`${unicodeBoundary}(${escapedWord})${unicodeBoundaryEnd}`, 'giu');
    const parts = sentence.split(regex);
    return parts.map((part, i) => 
      part.toLowerCase() === word.toLowerCase() ? (
        <span key={i} className="font-bold text-cyan-600 dark:text-cyan-300 bg-cyan-500/20 px-1 rounded">
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-cyan-500/10 border-cyan-500/30"
      data-testid={`whiteboard-item-context-${index}`}
    >
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-cyan-600 dark:text-cyan-400 opacity-60" />
        <span className="text-xl font-bold text-cyan-700 dark:text-cyan-300">
          {data.word}
        </span>
        <span className="text-sm text-muted-foreground">in context</span>
      </div>
      
      <div className="flex flex-col gap-2 pl-2 border-l-2 border-cyan-500/30">
        {data.sentences.map((sentence, i) => (
          <motion.p
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 + i * 0.15 }}
            className="text-base leading-relaxed"
          >
            {highlightWord(sentence, data.word)}
          </motion.p>
        ))}
      </div>
    </motion.div>
  );
};

interface ReadingItemDisplayProps {
  item: ReadingItem;
  index: number;
}

/**
 * Reading guide display - shows character with pronunciation annotation
 * Supports: furigana (Japanese), pinyin (Mandarin), romanization (Korean)
 * Uses ruby HTML element for proper reading annotation display
 */
const ReadingItemDisplay = ({ item, index }: ReadingItemDisplayProps) => {
  const { data } = item;
  
  const getLanguageLabel = (lang?: string): string => {
    switch (lang?.toLowerCase()) {
      case 'japanese':
      case 'ja':
        return 'Furigana';
      case 'mandarin':
      case 'chinese':
      case 'zh':
        return 'Pinyin';
      case 'korean':
      case 'ko':
        return 'Romanization';
      default:
        return 'Reading';
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-pink-500/10 border-pink-500/30"
      data-testid={`whiteboard-item-reading-${index}`}
    >
      <div className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-pink-600 dark:text-pink-400 opacity-60" />
        <span className="text-sm text-muted-foreground">{getLanguageLabel(data.language)}</span>
      </div>
      
      <div className="flex justify-center items-center py-2">
        <ruby className="text-3xl font-medium text-pink-700 dark:text-pink-300">
          {data.character}
          <rp>(</rp>
          <rt className="text-base text-pink-600 dark:text-pink-400">{data.reading}</rt>
          <rp>)</rp>
        </ruby>
      </div>
      
      {data.reading && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-center text-sm text-muted-foreground"
        >
          Pronunciation: <span className="font-mono text-pink-600 dark:text-pink-400">{data.reading}</span>
        </motion.p>
      )}
    </motion.div>
  );
};

interface StrokeItemDisplayProps {
  item: StrokeItem;
  index: number;
}

/**
 * Stroke order display - shows character with animated stroke order using HanziWriter
 * Supports: CJK characters (Chinese, Japanese Kanji, Korean Hanja)
 * Features: Play animation, replay button, stroke count display
 * Uses dynamic import to avoid SSR issues (HanziWriter requires window)
 */
const StrokeItemDisplay = ({ item, index }: StrokeItemDisplayProps) => {
  const { data } = item;
  const writerContainerRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [strokeCount, setStrokeCount] = useState<number | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  const getLanguageLabel = (lang?: string): string => {
    switch (lang?.toLowerCase()) {
      case 'japanese':
      case 'ja':
        return 'Japanese';
      case 'mandarin':
      case 'chinese':
      case 'zh':
        return 'Chinese';
      case 'korean':
      case 'ko':
        return 'Korean';
      default:
        return 'Character';
    }
  };
  
  useEffect(() => {
    if (!data.character || typeof window === 'undefined') {
      setIsLoading(false);
      setHasError(true);
      return;
    }

    let mounted = true;

    // Container is always in DOM (rendered with visibility:hidden during loading/error).
    // The ref is available immediately on mount because the div is unconditionally rendered.
    // initWriter is async so it can await the dynamic import — started via initWriter().
    const initWriter = async () => {
      // Guard: if ref is somehow not yet populated (e.g. very first paint), wait one tick.
      if (!writerContainerRef.current) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!mounted) return;
      if (!writerContainerRef.current) {
        setIsLoading(false);
        setHasError(true);
        return;
      }

      const container = writerContainerRef.current;
      try {
        const HanziWriterModule = await import('hanzi-writer');
        const HanziWriter = HanziWriterModule.default;
        
        if (!mounted || !container) return;
        
        container.innerHTML = '';
        
        const writer = HanziWriter.create(container, data.character, {
          width: 120,
          height: 120,
          padding: 5,
          showOutline: true,
          strokeAnimationSpeed: 1,
          delayBetweenStrokes: 300,
          strokeColor: '#ea580c',
          outlineColor: '#fdba74',
          drawingColor: '#c2410c',
          radicalColor: '#f97316',
          highlightColor: '#fb923c',
          showCharacter: true,
          onLoadCharDataSuccess: (charData: any) => {
            if (!mounted) return;
            setStrokeCount(charData?.strokes?.length || null);
            setIsSupported(true);
            setHasError(false);
            setIsLoading(false);
          },
          onLoadCharDataError: () => {
            if (!mounted) return;
            console.warn(`[HanziWriter] Character "${data.character}" not found in database`);
            setIsSupported(false);
            setHasError(true);
            setIsLoading(false);
          },
        });
        
        if (!mounted) {
          (writer as any).destroy?.();
          return;
        }
        
        writerRef.current = writer;
        
        setTimeout(() => {
          if (mounted && writerRef.current) {
            setIsAnimating(true);
            writerRef.current.animateCharacter({
              onComplete: () => {
                if (mounted) setIsAnimating(false);
              },
            });
          }
        }, 500);
        
      } catch (error) {
        if (mounted) {
          console.error('[HanziWriter] Failed to create writer:', error);
          setHasError(true);
          setIsLoading(false);
        }
      }
    };
    
    initWriter();
    
    return () => {
      mounted = false;
      if (writerRef.current) {
        try {
          (writerRef.current as any).destroy?.();
        } catch (e) {
        }
        writerRef.current = null;
      }
    };
  }, [data.character]);
  
  const handleReplay = useCallback(() => {
    if (writerRef.current && !isAnimating) {
      setIsAnimating(true);
      writerRef.current.animateCharacter({
        onComplete: () => setIsAnimating(false),
      });
    }
  }, [isAnimating]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-orange-500/10 border-orange-500/30"
      data-testid={`whiteboard-item-stroke-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PenTool className="h-4 w-4 text-orange-600 dark:text-orange-400 opacity-60" />
          <span className="text-sm text-muted-foreground">
            {getLanguageLabel(data.language)} Stroke Order
          </span>
        </div>
        {strokeCount && isSupported && (
          <span className="text-xs bg-orange-500/20 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded-full">
            {strokeCount} strokes
          </span>
        )}
      </div>
      
      <div className="flex justify-center items-center py-4 min-h-[140px] relative">
        {/* Writer container is ALWAYS in the DOM so the ref is available when the effect fires.
            Visibility is toggled via CSS — HanziWriter requires the element to exist on mount. */}
        <div
          className="relative"
          style={{ visibility: (isLoading || hasError || !isSupported) ? 'hidden' : 'visible' }}
        >
          <div 
            ref={writerContainerRef}
            className="w-[120px] h-[120px]"
            data-testid={`stroke-writer-${index}`}
          />
        </div>

        {/* Loading overlay */}
        {isLoading && !hasError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
          >
            <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
            <span className="text-xs text-muted-foreground">Loading stroke data...</span>
          </motion.div>
        )}

        {/* Error / unsupported overlay */}
        {(hasError || !isSupported) && (
          <motion.div
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 10 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
          >
            <span 
              className="text-6xl font-medium text-orange-700 dark:text-orange-300"
              style={{ fontFamily: '"Noto Sans JP", "Noto Sans SC", "Noto Sans KR", sans-serif' }}
            >
              {data.character}
            </span>
            <p className="text-xs text-orange-600/70 dark:text-orange-400/70">
              Stroke data not available
            </p>
          </motion.div>
        )}
      </div>
      
      {isSupported && !hasError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="flex justify-center"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReplay}
            disabled={isAnimating}
            className="text-orange-600 dark:text-orange-400 hover:bg-orange-500/20"
            data-testid={`stroke-replay-${index}`}
          >
            {isAnimating ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            {isAnimating ? 'Animating...' : 'Replay Animation'}
          </Button>
        </motion.div>
      )}
      
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-center text-xs text-muted-foreground"
      >
        Watch and learn the stroke order for "{data.character}"
      </motion.p>
    </motion.div>
  );
};

interface ToneItemDisplayProps {
  item: ToneItem;
  index: number;
}

/**
 * Tone visualization display - shows pitch contours for tonal languages
 * Visualizes Mandarin tones 1-4 (plus neutral tone 5) with animated curves
 * Helps learners understand tone shapes visually
 */
const ToneItemDisplay = ({ item, index }: ToneItemDisplayProps) => {
  const { data } = item;
  
  const getToneLabel = (tone: number) => {
    switch (tone) {
      case 1: return { name: 'High', color: 'text-red-500', shape: '━━━' };
      case 2: return { name: 'Rising', color: 'text-green-500', shape: '╱' };
      case 3: return { name: 'Dip', color: 'text-blue-500', shape: '╲╱' };
      case 4: return { name: 'Falling', color: 'text-purple-500', shape: '╲' };
      case 5: return { name: 'Neutral', color: 'text-gray-400', shape: '・' };
      default: return { name: 'Unknown', color: 'text-gray-400', shape: '?' };
    }
  };

  const getToneSVG = (tone: number, size: number = 60) => {
    const h = size;
    const w = size;
    // Accurate Mandarin tone contours:
    // T1: High level (flat line at top)
    // T2: Rising (mid-low to high)
    // T3: Low dipping (mid-low, dip down, rise slightly)
    // T4: Falling (high to low, straight)
    // T5: Neutral (short, mid-level)
    const paths: Record<number, string> = {
      1: `M 10,12 L ${w-10},12`,                                    // High flat
      2: `M 10,${h-18} Q ${w*0.7},${h/2-5} ${w-10},12`,             // Rising curve
      3: `M 10,${h/2-5} Q ${w*0.35},${h-8} ${w*0.5},${h-12} Q ${w*0.65},${h-8} ${w-10},${h/2+5}`, // Low dip
      4: `M 10,12 L ${w-10},${h-18}`,                               // Straight falling
      5: `M ${w*0.3},${h/2} L ${w*0.7},${h/2}`,                     // Short neutral
    };
    const colors: Record<number, string> = {
      1: '#ef4444',
      2: '#22c55e',
      3: '#3b82f6',
      4: '#a855f7',
      5: '#9ca3af',
    };
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
        <path
          d={paths[tone] || paths[5]}
          fill="none"
          stroke={colors[tone] || colors[5]}
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {tone === 5 && (
          <circle cx={w/2} cy={h/2} r="4" fill={colors[5]} />
        )}
        <text x={w/2} y={h+15} textAnchor="middle" className="fill-current text-xs font-medium">
          T{tone}
        </text>
      </svg>
    );
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-fuchsia-500/10 border-fuchsia-500/30"
      data-testid={`whiteboard-item-tone-${index}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-fuchsia-600 dark:text-fuchsia-400 opacity-60" />
          <span className="text-sm text-muted-foreground">Tone Visualization</span>
        </div>
        {data.language && (
          <span className="text-xs bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300 px-2 py-0.5 rounded-full capitalize">
            {data.language}
          </span>
        )}
      </div>
      
      <div className="flex flex-col items-center gap-2 py-2">
        <motion.span
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 10 }}
          className="text-3xl font-bold text-fuchsia-700 dark:text-fuchsia-300"
        >
          {data.word}
        </motion.span>
        {data.pinyin && (
          <span className="text-lg font-mono text-fuchsia-600 dark:text-fuchsia-400">
            {data.pinyin}
          </span>
        )}
        {data.meaning && (
          <span className="text-sm text-muted-foreground">
            "{data.meaning}"
          </span>
        )}
      </div>
      
      <div className="flex justify-center gap-4 py-2">
        {data.tones.map((tone: number, i: number) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.1 }}
            className="flex flex-col items-center"
          >
            {getToneSVG(tone)}
            <span className={`text-xs mt-1 ${getToneLabel(tone).color}`}>
              {getToneLabel(tone).name}
            </span>
          </motion.div>
        ))}
      </div>
      
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-center text-xs text-muted-foreground"
      >
        Practice matching the pitch contour when speaking
      </motion.p>
    </motion.div>
  );
};

interface WordMapItemDisplayProps {
  item: WordMapItem;
  index: number;
}

/**
 * Word map display - shows visual web of related words
 * Displays synonyms, antonyms, collocations, and word family
 * Uses radial layout to show word relationships
 */
const WordMapItemDisplay = ({ item, index }: WordMapItemDisplayProps) => {
  const { data } = item;
  
  const hasRelations = data.synonyms?.length || data.antonyms?.length || 
    data.collocations?.length || data.wordFamily?.length;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-teal-500/10 border-teal-500/30"
      data-testid={`whiteboard-item-word-map-${index}`}
    >
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-teal-600 dark:text-teal-400 opacity-60" />
        <span className="text-sm text-muted-foreground">Word Map</span>
      </div>
      
      <div className="flex justify-center items-center py-2">
        <motion.span
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 10 }}
          className="text-2xl font-bold text-teal-700 dark:text-teal-300 px-4 py-2 bg-teal-500/20 rounded-full"
        >
          {data.targetWord}
        </motion.span>
      </div>
      
      {data.isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
          <span className="ml-2 text-sm text-muted-foreground">Finding related words...</span>
        </div>
      ) : hasRelations ? (
        <div className="grid gap-3">
          {data.synonyms && data.synonyms.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="flex flex-wrap gap-1.5 items-center"
            >
              <span className="text-xs font-medium text-teal-600 dark:text-teal-400 w-20">Synonyms:</span>
              {data.synonyms.map((word, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.15 + i * 0.05 }}
                  className="px-2 py-0.5 text-sm bg-teal-500/15 rounded-md text-teal-700 dark:text-teal-300"
                >
                  {word}
                </motion.span>
              ))}
            </motion.div>
          )}
          
          {data.antonyms && data.antonyms.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className="flex flex-wrap gap-1.5 items-center"
            >
              <span className="text-xs font-medium text-rose-600 dark:text-rose-400 w-20">Antonyms:</span>
              {data.antonyms.map((word, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.25 + i * 0.05 }}
                  className="px-2 py-0.5 text-sm bg-rose-500/15 rounded-md text-rose-700 dark:text-rose-300"
                >
                  {word}
                </motion.span>
              ))}
            </motion.div>
          )}
          
          {data.collocations && data.collocations.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 }}
              className="flex flex-wrap gap-1.5 items-center"
            >
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400 w-20">Common:</span>
              {data.collocations.map((phrase, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.35 + i * 0.05 }}
                  className="px-2 py-0.5 text-sm bg-amber-500/15 rounded-md text-amber-700 dark:text-amber-300"
                >
                  {phrase}
                </motion.span>
              ))}
            </motion.div>
          )}
          
          {data.wordFamily && data.wordFamily.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 }}
              className="flex flex-wrap gap-1.5 items-center"
            >
              <span className="text-xs font-medium text-violet-600 dark:text-violet-400 w-20">Family:</span>
              {data.wordFamily.map((word, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.45 + i * 0.05 }}
                  className="px-2 py-0.5 text-sm bg-violet-500/15 rounded-md text-violet-700 dark:text-violet-300"
                >
                  {word}
                </motion.span>
              ))}
            </motion.div>
          )}
        </div>
      ) : (
        <div className="py-3 text-center">
          <p className="text-sm text-muted-foreground italic">
            Exploring word relationships for <span className="font-semibold">{data.targetWord}</span>
          </p>
        </div>
      )}
    </motion.div>
  );
};

interface CultureItemDisplayProps {
  item: CultureItem;
  index: number;
}

/**
 * Get icon for cultural category
 */
const getCultureCategoryIcon = (category?: string) => {
  switch (category?.toLowerCase()) {
    case 'food':
    case 'dining':
      return <Utensils className="h-4 w-4" />;
    case 'gestures':
    case 'body language':
      return <HandMetal className="h-4 w-4" />;
    case 'holidays':
    case 'festivals':
      return <Calendar className="h-4 w-4" />;
    case 'etiquette':
    case 'customs':
      return <Users className="h-4 w-4" />;
    default:
      return <Globe className="h-4 w-4" />;
  }
};

/**
 * Culture display - shows cultural insights, customs, etiquette
 * Helps learners understand cultural context beyond vocabulary
 */
const CultureItemDisplay = ({ item, index }: CultureItemDisplayProps) => {
  const { data } = item;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-amber-500/10 border-amber-500/30"
      data-testid={`whiteboard-item-culture-${index}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-amber-600 dark:text-amber-400 opacity-80">
          {getCultureCategoryIcon(data.category)}
        </span>
        {data.category && (
          <span className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400 font-medium">
            {data.category}
          </span>
        )}
      </div>
      
      <h3 className="text-lg font-bold text-amber-800 dark:text-amber-200">
        {data.topic}
      </h3>
      
      <p className="text-sm text-amber-900/80 dark:text-amber-100/80 leading-relaxed">
        {data.context}
      </p>
    </motion.div>
  );
};

interface PlayItemDisplayProps {
  item: PlayItem;
  index: number;
  language?: string;
}

const PlayItemDisplay = ({ item, index, language }: PlayItemDisplayProps) => {
  const { data } = item;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  const speed = data.speed || 'normal';
  
  const speedLabel = {
    slow: '0.5x',
    normal: '1x',
    fast: '1.5x',
  }[speed];
  
  const speedRate = {
    slow: 0.5,
    normal: 1.0,
    fast: 1.5,
  }[speed];
  
  const speedColor = {
    slow: 'text-green-600 dark:text-green-400',
    normal: 'text-sky-600 dark:text-sky-400',
    fast: 'text-orange-600 dark:text-orange-400',
  }[speed];
  
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);
  
  const handlePlay = useCallback(async () => {
    if (isLoading) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
      return;
    }
    
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      return;
    }
    
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;
    
    try {
      setIsLoading(true);
      
      const result = await synthesizeSpeech(
        data.text,
        language,
        undefined,
        language,
        false,
        undefined,
        speedRate,
        signal
      );
      
      if (signal.aborted) return;
      
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      
      const audioUrl = URL.createObjectURL(result.audioBlob);
      audioUrlRef.current = audioUrl;
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      
      audio.onended = () => {
        setIsPlaying(false);
      };
      
      audio.onerror = () => {
        setIsPlaying(false);
        console.error('[PLAY] Audio playback error');
      };
      
      if (signal.aborted) return;
      
      setIsPlaying(true);
      await audio.play();
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('[PLAY] Failed to synthesize speech:', error);
      }
      setIsPlaying(false);
    } finally {
      setIsLoading(false);
    }
  }, [isPlaying, isLoading, data.text, language, speedRate]);
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex items-center gap-4 p-4 rounded-lg border bg-sky-500/10 border-sky-500/30"
      data-testid={`whiteboard-item-play-${index}`}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={handlePlay}
        disabled={isLoading}
        className={`h-12 w-12 rounded-full ${isPlaying ? 'bg-sky-500/20' : 'bg-sky-500/10'} hover:bg-sky-500/20`}
        data-testid={`play-button-${index}`}
      >
        {isLoading ? (
          <Loader2 className="h-6 w-6 text-sky-600 dark:text-sky-400 animate-spin" />
        ) : isPlaying ? (
          <Square className="h-5 w-5 text-sky-600 dark:text-sky-400" />
        ) : (
          <Play className="h-6 w-6 text-sky-600 dark:text-sky-400" />
        )}
      </Button>
      
      <div className="flex flex-col gap-1 flex-1">
        <span className="text-lg font-medium text-sky-900 dark:text-sky-100">
          {data.text}
        </span>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${speedColor}`}>
            {speedLabel}
          </span>
        </div>
      </div>
    </motion.div>
  );
};

interface ScenarioItemDisplayProps {
  item: ScenarioItem;
  index: number;
}

const ScenarioItemDisplay = ({ item, index }: ScenarioItemDisplayProps) => {
  const data = item.data || {};
  const mood = data.mood || 'casual';
  
  const moodStyles: Record<string, { icon: typeof Sparkles; color: string }> = {
    formal: { icon: Users, color: 'text-purple-600 dark:text-purple-400' },
    casual: { icon: Sparkles, color: 'text-purple-500 dark:text-purple-300' },
    urgent: { icon: Target, color: 'text-red-500 dark:text-red-400' },
    friendly: { icon: Star, color: 'text-yellow-500 dark:text-yellow-400' },
  };
  
  const moodInfo = moodStyles[mood] || moodStyles.casual;
  const MoodIcon = moodInfo.icon;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-purple-500/10 border-purple-500/30"
      data-testid={`whiteboard-item-scenario-${index}`}
    >
      <div className="flex items-center gap-2">
        <MapPin className="h-5 w-5 text-purple-600 dark:text-purple-400" />
        <span className="text-lg font-bold text-purple-800 dark:text-purple-200">
          {data.location}
        </span>
        <span className={`ml-auto flex items-center gap-1 text-xs uppercase tracking-wide font-medium ${moodInfo.color}`}>
          <MoodIcon className="h-3 w-3" />
          {mood}
        </span>
      </div>
      
      <p className="text-sm text-purple-900/80 dark:text-purple-100/80 leading-relaxed italic">
        "{data.situation}"
      </p>
    </motion.div>
  );
};

interface SummaryItemDisplayProps {
  item: SummaryItem;
  index: number;
}

const SummaryItemDisplay = ({ item, index }: SummaryItemDisplayProps) => {
  const { data } = item;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-emerald-500/10 border-emerald-500/30"
      data-testid={`whiteboard-item-summary-${index}`}
    >
      <div className="flex items-center gap-2">
        <ListChecks className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        <h3 className="text-lg font-bold text-emerald-800 dark:text-emerald-200">
          {data.title}
        </h3>
      </div>
      
      {data.words.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs uppercase tracking-wide text-emerald-600/80 dark:text-emerald-400/80 font-medium">
            Words Learned
          </span>
          <div className="flex flex-wrap gap-2">
            {data.words.map((word, i) => (
              <span 
                key={i}
                className="px-2 py-1 text-sm rounded-md bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border border-emerald-500/30 font-medium"
              >
                {word}
              </span>
            ))}
          </div>
        </div>
      )}
      
      {data.phrases.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs uppercase tracking-wide text-emerald-600/80 dark:text-emerald-400/80 font-medium">
            Key Phrases
          </span>
          <ul className="space-y-1">
            {data.phrases.map((phrase, i) => (
              <li 
                key={i}
                className="text-sm text-emerald-900/80 dark:text-emerald-100/80 pl-3 border-l-2 border-emerald-500/40"
              >
                {phrase}
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
};

interface ErrorPatternsItemDisplayProps {
  item: ErrorPatternsItem;
  index: number;
}

const ErrorPatternsItemDisplay = ({ item, index }: ErrorPatternsItemDisplayProps) => {
  const { data } = item;
  
  const getCategoryColor = (category: string) => {
    switch (category.toLowerCase()) {
      case 'pronunciation':
        return 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/30';
      case 'grammar':
        return 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30';
      case 'vocabulary':
        return 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
      case 'conjugation':
        return 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/30';
      default:
        return 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border-rose-500/30';
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-rose-500/10 border-rose-500/30"
      data-testid={`whiteboard-item-error-patterns-${index}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-rose-600 dark:text-rose-400" />
        <h3 className="text-lg font-bold text-rose-800 dark:text-rose-200">
          {data.category ? `${data.category} Patterns` : 'Common Mistakes'}
        </h3>
      </div>
      
      {data.isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-rose-500" />
          <span className="ml-2 text-sm text-muted-foreground">Loading patterns...</span>
        </div>
      ) : data.patterns.length > 0 ? (
        <div className="space-y-3">
          {data.patterns.map((pattern, i) => (
            <motion.div
              key={pattern.id || i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 + i * 0.05 }}
              className="flex flex-col gap-1 p-3 bg-background/50 rounded-lg border border-rose-500/20"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-rose-600 dark:text-rose-400 line-through text-sm">
                    {pattern.incorrect}
                  </span>
                  <span className="text-muted-foreground">→</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium text-sm">
                    {pattern.correct}
                  </span>
                </div>
                <span className={`px-2 py-0.5 text-xs rounded-full border ${getCategoryColor(pattern.category)}`}>
                  {pattern.category}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Occurred {pattern.frequency}x</span>
                {pattern.lastOccurred && (
                  <>
                    <span>•</span>
                    <span>Last: {new Date(pattern.lastOccurred).toLocaleDateString()}</span>
                  </>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="py-3 text-center">
          <p className="text-sm text-muted-foreground italic">
            No error patterns recorded yet. Keep practicing!
          </p>
        </div>
      )}
    </motion.div>
  );
};

interface VocabularyTimelineItemDisplayProps {
  item: VocabularyTimelineItem;
  index: number;
}

const VocabularyTimelineItemDisplay = ({ item, index }: VocabularyTimelineItemDisplayProps) => {
  const { data } = item;
  
  const getProficiencyColor = (proficiency: string) => {
    switch (proficiency) {
      case 'new':
        return 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/30';
      case 'learning':
        return 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30';
      case 'familiar':
        return 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
      case 'mastered':
        return 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/30';
      default:
        return 'bg-gray-500/20 text-gray-700 dark:text-gray-300 border-gray-500/30';
    }
  };
  
  const getSourceIcon = (source: string) => {
    switch (source.toLowerCase()) {
      case 'conversation':
        return <Volume2 className="h-3 w-3" />;
      case 'lesson':
        return <BookOpen className="h-3 w-3" />;
      case 'drill':
        return <Target className="h-3 w-3" />;
      default:
        return <Clock className="h-3 w-3" />;
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-blue-500/10 border-blue-500/30"
      data-testid={`whiteboard-item-vocabulary-timeline-${index}`}
    >
      <div className="flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        <h3 className="text-lg font-bold text-blue-800 dark:text-blue-200">
          {data.topic ? `${data.topic} Vocabulary` : 'Recent Vocabulary'}
        </h3>
        {data.timeRange && (
          <span className="text-xs text-muted-foreground capitalize">
            ({data.timeRange})
          </span>
        )}
      </div>
      
      {data.isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-muted-foreground">Loading vocabulary...</span>
        </div>
      ) : data.entries.length > 0 ? (
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-blue-500/20" />
          <div className="space-y-3">
            {data.entries.map((entry, i) => (
              <motion.div
                key={entry.id || i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.05 }}
                className="relative flex items-start gap-3 pl-8"
              >
                <div className="absolute left-2 top-2 w-4 h-4 rounded-full bg-blue-500/30 border-2 border-blue-500/50 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                </div>
                <div className="flex-1 p-3 bg-background/50 rounded-lg border border-blue-500/20">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium text-blue-900 dark:text-blue-100">
                      {entry.word}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded-full border ${getProficiencyColor(entry.proficiency)}`}>
                      {entry.proficiency}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mb-1">{entry.translation}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      {getSourceIcon(entry.source)}
                      {entry.source}
                    </span>
                    <span>•</span>
                    <span>{new Date(entry.learnedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      ) : (
        <div className="py-3 text-center">
          <p className="text-sm text-muted-foreground italic">
            No vocabulary recorded yet. Start learning!
          </p>
        </div>
      )}
    </motion.div>
  );
};

interface GrammarTableItemDisplayProps {
  item: GrammarTableItem;
  index: number;
}

const GrammarTableItemDisplay = ({ item, index }: GrammarTableItemDisplayProps) => {
  const { data } = item;
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-indigo-500/10 border-indigo-500/30"
      data-testid={`whiteboard-item-grammar-table-${index}`}
    >
      <div className="flex items-center gap-2">
        <Table2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400 opacity-60" />
        <span className="text-xl font-bold text-indigo-700 dark:text-indigo-300">
          {data.verb}
        </span>
        <span className="text-sm text-muted-foreground capitalize">
          ({data.tense})
        </span>
      </div>
      
      {data.isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
          <span className="ml-2 text-sm text-muted-foreground">Loading conjugations...</span>
        </div>
      ) : data.conjugations && data.conjugations.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {data.conjugations.map((conj, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.05 }}
              className="flex items-center gap-2 px-3 py-2 bg-indigo-500/10 rounded"
            >
              <span className="text-sm text-muted-foreground w-12">{conj.pronoun}</span>
              <span className="font-medium text-indigo-700 dark:text-indigo-300">{conj.form}</span>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="py-3 text-center">
          <p className="text-sm text-muted-foreground italic mb-2">
            {data.tense.charAt(0).toUpperCase() + data.tense.slice(1)} tense of <span className="font-semibold">{data.verb}</span>
          </p>
          <p className="text-xs text-muted-foreground/70">
            Conjugation patterns help you recognize verb forms
          </p>
        </div>
      )}
    </motion.div>
  );
};

interface TextInputItemDisplayProps {
  item: TextInputItem;
  index: number;
  onSubmit?: (itemId: string, response: string) => void;
}

const TextInputItemDisplay = ({ item, index, onSubmit }: TextInputItemDisplayProps) => {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(item.data.isSubmitted || false);
  
  const handleSubmit = () => {
    if (!text.trim() || isSubmitting || isSubmitted) return;
    setIsSubmitting(true);
    onSubmit?.(item.id || '', text.trim());
    setIsSubmitted(true);
    setIsSubmitting(false);
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.95 }}
      transition={{ duration: 0.3, delay: index * 0.1 }}
      className="flex flex-col gap-3 p-4 rounded-lg border bg-lime-500/10 border-lime-500/30"
      data-testid={`whiteboard-item-text-input-${index}`}
    >
      <div className="flex items-center gap-2">
        <PenLine className="h-4 w-4 text-lime-600 dark:text-lime-400 opacity-60" />
        <span className="text-sm font-medium text-lime-700 dark:text-lime-300">
          Writing Practice
        </span>
      </div>
      
      <p className="text-foreground font-medium">
        {item.data.prompt}
      </p>
      
      {isSubmitted ? (
        <div className="flex items-center gap-2 py-2 px-3 bg-lime-500/20 rounded-lg">
          <CheckCircle2 className="h-4 w-4 text-lime-600 dark:text-lime-400" />
          <span className="text-sm text-lime-700 dark:text-lime-300">
            Response submitted! Listen for feedback...
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={item.data.placeholder || "Type your response here..."}
            className="min-h-[60px] resize-none bg-background/50 border-lime-500/30 focus:border-lime-500/50"
            disabled={isSubmitting}
            data-testid={`input-text-response-${index}`}
          />
          <Button
            onClick={handleSubmit}
            disabled={!text.trim() || isSubmitting}
            className="self-end gap-2"
            size="sm"
            data-testid={`button-submit-text-response-${index}`}
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Submit
          </Button>
        </div>
      )}
    </motion.div>
  );
};

// ─── Sentence Table (Substitution drill) ───────────────────────────
function SentenceTableItemDisplay({ item, index }: { item: SentenceTableItem; index: number }) {
  const { columns, patternLabel } = item.data;
  if (!columns || columns.length === 0) return null;
  const maxRows = Math.max(...columns.map(c => c.items.length));

  return (
    <div className="space-y-2" data-testid={`whiteboard-item-sentence-table-${index}`}>
      {patternLabel && (
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{patternLabel}</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              {columns.map((col, ci) => (
                <th
                  key={ci}
                  className="text-left px-3 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border/60 uppercase tracking-wide"
                >
                  {col.header || `Column ${ci + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxRows }).map((_, ri) => (
              <tr key={ri} className="border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors">
                {columns.map((col, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 font-medium"
                    data-testid={`sentence-table-cell-${index}-${ri}-${ci}`}
                  >
                    {col.items[ri] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Each row is a complete sentence — swap any column to make a new one.
      </p>
    </div>
  );
}

// ─── Textbook Search Results ──────────────────────────────────────────────────
function TextbookSearchItemDisplay({ item, index }: { item: TextbookSearchItem; index: number }) {
  const { query, matches } = item.data;

  return (
    <div className="space-y-2" data-testid={`whiteboard-item-textbook-search-${index}`}>
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        <p className="text-sm font-medium">
          Results for &ldquo;<span className="text-foreground">{query}</span>&rdquo;
        </p>
      </div>
      {matches.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No chapters found covering this topic yet.</p>
      ) : (
        <div className="space-y-2">
          {matches.map((match, mi) => (
            <div
              key={mi}
              className="rounded-md border border-border/50 bg-background/60 px-3 py-2 space-y-0.5"
              data-testid={`textbook-search-match-${index}-${mi}`}
            >
              <div className="flex items-center gap-2">
                {match.chapterNumber !== undefined && (
                  <span className="text-xs font-semibold text-muted-foreground shrink-0">Ch.{match.chapterNumber}</span>
                )}
                <span className="text-sm font-semibold text-foreground">{match.unitName}</span>
              </div>
              <p className="text-xs text-muted-foreground">{match.lessonName}</p>
              {match.excerpt && (
                <p className="text-xs text-foreground/70 line-clamp-2">{match.excerpt}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Vocab Card ───────────────────────────────────────────────────────────────

export function VocabCardItemDisplay({ item, index }: { item: VocabCardItem; index: number }) {
  const { data } = item;
  return (
    <div
      className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300"
      data-testid={`whiteboard-item-vocab-card-${index}`}
    >
      <div className="flex items-center gap-2 pb-1 border-b border-border/50">
        <BookOpen className="h-4 w-4 text-blue-500 shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
          Vocabulary
        </span>
        {data.language && (
          <span className="ml-auto text-xs text-muted-foreground uppercase">{data.language}</span>
        )}
      </div>
      <div className="space-y-2">
        {data.imageUrl && (
          <img
            src={data.imageUrl}
            alt={data.word}
            className="w-full max-h-72 object-contain rounded-md"
          />
        )}
        <div className="space-y-1 min-w-0">
          <p className="text-2xl font-bold text-foreground leading-tight">{data.word}</p>
          {data.showTranslation !== false ? (
            <p className="text-sm text-muted-foreground">{data.definition}</p>
          ) : (
            <p className="text-xs text-muted-foreground/60 italic">What does this mean?</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Teaching Card ────────────────────────────────────────────────────────────

function TeachingCardItemDisplay({ item, index }: { item: TeachingCardItem; index: number }) {
  const { data } = item;
  const durationMs = data.autoDismissMs ?? 8000;
  return (
    <div
      className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300"
      data-testid={`whiteboard-item-teaching-card-${index}`}
    >
      <div className="flex items-center gap-2 pb-1 border-b border-border/50">
        <Zap className="h-4 w-4 text-amber-500 shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
          Quick Note
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {Math.round(durationMs / 1000)}s
        </span>
      </div>
      {data.word && (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xl font-bold text-foreground">{data.word}</span>
          {data.translation && (
            <span className="text-sm text-muted-foreground">— {data.translation}</span>
          )}
        </div>
      )}
      {data.grammarRule && !data.word && (
        <p className="text-sm text-foreground">{data.grammarRule}</p>
      )}
      {data.grammarRule && data.word && (
        <p className="text-xs text-muted-foreground italic">{data.grammarRule}</p>
      )}
      {data.examples && data.examples.length > 0 && (
        <ul className="space-y-1">
          {data.examples.map((ex, i) => (
            <li key={i} className="text-xs text-foreground/80 before:content-['›'] before:mr-1.5 before:text-amber-500">
              {ex}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Textbook Page Card ────────────────────────────────────────────────────────

function TextbookPageItemDisplay({ item, index }: { item: TextbookPageItem; index: number }) {
  const { data } = item;
  return (
    <div className="space-y-3" data-testid={`whiteboard-item-textbook-page-${index}`}>
      <div className="flex items-center gap-2 pb-1.5 border-b border-border/50">
        <BookOpen className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {data.lessonId}
          </p>
          {data.actflLevel && (
            <p className="text-xs text-muted-foreground">{data.actflLevel}</p>
          )}
        </div>
      </div>

      {data.vocabulary && data.vocabulary.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Vocabulary
          </p>
          <div className="space-y-1">
            {data.vocabulary.map((v, i) => (
              <div key={i} className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">{v.word}</span>
                {v.translation && (
                  <span className="text-xs text-muted-foreground">{v.translation}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.grammarPattern && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Grammar Pattern
          </p>
          <p className="text-sm text-foreground/90 leading-relaxed">{data.grammarPattern}</p>
        </div>
      )}

      {data.examples && data.examples.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Key Examples
          </p>
          <div className="space-y-2">
            {data.examples.map((e, i) => (
              <div key={i} className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">{e.target}</p>
                {e.translation && (
                  <p className="text-xs text-muted-foreground">{e.translation}</p>
                )}
                {e.note && (
                  <p className="text-xs text-muted-foreground/70 italic">{e.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.sentencePatterns && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Sentence Patterns
          </p>
          <p className="text-sm text-foreground/80 leading-relaxed">{data.sentencePatterns}</p>
        </div>
      )}
    </div>
  );
}

// ─── Daily Plan Card ──────────────────────────────────────────────────────────

function agendaIcon(type: DailyPlanAgendaItem['type']) {
  switch (type) {
    case 'vocab_review': return <RotateCcw className="w-4 h-4" />;
    case 'lesson':       return <BookOpen className="w-4 h-4" />;
    case 'assignment':   return <ClipboardList className="w-4 h-4" />;
    case 'practice':     return <Zap className="w-4 h-4" />;
    case 'conversation': return <MessageSquare className="w-4 h-4" />;
    default:             return <CheckCircle2 className="w-4 h-4" />;
  }
}

function DailyPlanCard({ item, index }: { item: DailyPlanItem; index: number }) {
  const { data } = item;
  const { greeting, dateLabel, agenda, stats } = data;

  const sessionsDisplay = `${stats.sessionsThisWeek}/${stats.goalSessionsPerWeek}`;
  const weekProgress = Math.min(stats.sessionsThisWeek / (stats.goalSessionsPerWeek || 5), 1);

  return (
    <div
      className="rounded-xl border border-border bg-card text-card-foreground overflow-hidden"
      data-testid={`whiteboard-daily-plan-${index}`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/40">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground">{dateLabel}</p>
            <h2 className="text-base font-semibold leading-tight">{greeting}</h2>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <CalendarDays className="w-3.5 h-3.5" />
              <span>{sessionsDisplay} this week</span>
            </span>
            {stats.dueVocabCount > 0 && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{stats.dueVocabCount} due</span>
              </span>
            )}
          </div>
        </div>
        {/* Week progress bar */}
        <div className="mt-2 h-1 rounded-full bg-border overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${weekProgress * 100}%` }}
          />
        </div>
      </div>

      {/* Agenda list */}
      <div className="divide-y divide-border">
        {agenda.map((agendaItem, i) => (
          <div
            key={agendaItem.id}
            className="flex items-center gap-3 px-4 py-3"
            data-testid={`daily-plan-item-${agendaItem.id}`}
          >
            <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
              agendaItem.urgency === 'due'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                : 'bg-primary/10 text-primary'
            }`}>
              {agendaIcon(agendaItem.type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug truncate">{agendaItem.label}</p>
              {agendaItem.detail && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">{agendaItem.detail}</p>
              )}
            </div>
            {agendaItem.urgency === 'due' && (
              <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                Due
              </span>
            )}
            <ChevronRight className="shrink-0 w-4 h-4 text-muted-foreground" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── WhiteboardItemDisplay ────────────────────────────────────────────────────

const WhiteboardItemDisplay = ({ 
  item, 
  index,
  onDrillResponse,
  onDrillStart,
  onDrillComplete,
  onTextInputSubmit,
  language,
}: { 
  item: WhiteboardItem; 
  index: number;
  onDrillResponse?: (drillId: string, response: string) => void;
  onDrillStart?: (drillId: string) => void;
  onDrillComplete?: (drillId: string, drillType: string, isCorrect: boolean, responseTimeMs: number, toolContent?: string) => void;
  onTextInputSubmit?: (itemId: string, response: string) => void;
  language?: string;
}) => {
  // Track when drills are displayed for response time calculation
  const drillDisplayTimeRef = useRef<number>(Date.now());
  
  if (isComparisonItem(item)) {
    return <ComparisonItemDisplay item={item} index={index} />;
  }

  if (isImageItem(item)) {
    return <ImageItemDisplay item={item} index={index} />;
  }
  
  if (isDrillItem(item)) {
    // Create a wrapper for drill completion that calculates response time
    const handleDrillComplete = (drillId: string, isCorrect: boolean) => {
      if (onDrillComplete) {
        const responseTimeMs = Date.now() - drillDisplayTimeRef.current;
        const toolContent = item.data?.prompt || item.content;
        onDrillComplete(drillId, item.data?.drillType || 'unknown', isCorrect, responseTimeMs, toolContent);
      }
    };
    
    if (isMatchingDrill(item)) {
      return <MatchDrillDisplay item={item} index={index} onMatchComplete={handleDrillComplete} />;
    }
    if (isFillBlankDrill(item)) {
      return <FillBlankDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isSentenceOrderDrill(item)) {
      return <SentenceOrderDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isMultipleChoiceDrill(item)) {
      return <MultipleChoiceDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isTrueFalseDrill(item)) {
      return <TrueFalseDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isConjugationDrill(item)) {
      return <ConjugationDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isDictationDrill(item)) {
      return <DictationDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isSpeakDrill(item)) {
      return <SpeakDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isCognateMatchDrill(item)) {
      return <CognateMatchDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    if (isFalseFriendTrapDrill(item)) {
      return <FalseFriendTrapDrillDisplay item={item} index={index} onComplete={handleDrillComplete} />;
    }
    return (
      <DrillItemDisplay 
        item={item} 
        index={index} 
        onResponse={onDrillResponse}
        onStart={onDrillStart}
        language={language}
      />
    );
  }
  
  if (isPronunciationItem(item)) {
    return <PronunciationItemDisplay item={item} index={index} />;
  }
  
  if (isContextItem(item)) {
    return <ContextItemDisplay item={item} index={index} />;
  }
  
  if (isGrammarTableItem(item)) {
    return <GrammarTableItemDisplay item={item} index={index} />;
  }
  
  if (isReadingItem(item)) {
    return <ReadingItemDisplay item={item} index={index} />;
  }
  
  if (isStrokeItem(item)) {
    return <StrokeItemDisplay item={item} index={index} />;
  }
  
  if (isToneItem(item)) {
    return <ToneItemDisplay item={item} index={index} />;
  }
  
  if (isWordMapItem(item)) {
    return <WordMapItemDisplay item={item} index={index} />;
  }
  
  if (isCultureItem(item)) {
    return <CultureItemDisplay item={item} index={index} />;
  }
  
  if (isPlayItem(item)) {
    return <PlayItemDisplay item={item} index={index} language={language} />;
  }
  
  if (isScenarioItem(item)) {
    return <ScenarioItemDisplay item={item} index={index} />;
  }
  
  if (isSummaryItem(item)) {
    return <SummaryItemDisplay item={item} index={index} />;
  }
  
  if (isErrorPatternsItem(item)) {
    return <ErrorPatternsItemDisplay item={item} index={index} />;
  }
  
  if (isVocabularyTimelineItem(item)) {
    return <VocabularyTimelineItemDisplay item={item} index={index} />;
  }
  
  if (isTextInputItem(item)) {
    return <TextInputItemDisplay item={item} index={index} onSubmit={onTextInputSubmit} />;
  }

  if (isDialogueItem(item)) {
    return <DialogueItemDisplay item={item} index={index} />;
  }

  if (isSceneCanvasItem(item)) {
    return (
      <SceneCanvas
        data={item.data}
        data-testid={`whiteboard-item-scene-canvas-${index}`}
      />
    );
  }

  if (isSentenceTableItem(item)) {
    return <SentenceTableItemDisplay item={item} index={index} />;
  }

  if (isTextbookSearchItem(item)) {
    return <TextbookSearchItemDisplay item={item} index={index} />;
  }

  if (isDailyPlanItem(item)) {
    return <DailyPlanCard item={item} index={index} />;
  }

  if (isTextbookPageItem(item)) {
    return <TextbookPageItemDisplay item={item} index={index} />;
  }

  if (isTeachingCardItem(item)) {
    return <TeachingCardItemDisplay item={item} index={index} />;
  }

  if (isVocabCardItem(item)) {
    return <VocabCardItemDisplay item={item} index={index} />;
  }

  // word_echo items are rendered as overlays in WhiteboardPanel — never reach here
  if (isWordEchoItem(item)) {
    return null;
  }

  return <TextItemDisplay item={item} index={index} />;
};

export function Whiteboard({ items, onClear, onDrillResponse, onDrillStart, onDrillComplete, onTextInputSubmit, language: propLanguage }: WhiteboardProps) {
  const { language: contextLanguage } = useLanguage();
  const language = propLanguage || contextLanguage;
  
  if (items.length === 0) {
    return null;
  }
  
  return (
    <div 
      className="fixed bottom-44 left-0 right-0 z-40 px-4 pointer-events-none"
      data-testid="whiteboard-container"
    >
      <div className="max-w-2xl mx-auto pointer-events-auto">
        <div className="relative bg-background/95 backdrop-blur-md rounded-xl border border-border shadow-lg p-4">
          {onClear && (
            <button
              onClick={onClear}
              className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Clear whiteboard"
              data-testid="button-clear-whiteboard"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          
          <AnimatePresence mode="sync">
            <div className="flex flex-col gap-2">
              {items.map((item, index) => (
                <WhiteboardItemDisplay 
                  key={item.id || `${item.type}-${item.content}-${index}`} 
                  item={item} 
                  index={index}
                  onDrillResponse={onDrillResponse}
                  onDrillStart={onDrillStart}
                  onDrillComplete={onDrillComplete}
                  onTextInputSubmit={onTextInputSubmit}
                  language={language}
                />
              ))}
            </div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/**
 * Panel whiteboard variant for desktop right panel
 * Renders whiteboard items in a scrollable panel layout (no fixed positioning)
 * Used by DesktopChatLayout's right panel
 */
export function PanelWhiteboard({ 
  items,
  onClear,
  onDrillResponse,
  onDrillStart,
  onDrillComplete,
  onTextInputSubmit,
  language: propLanguage,
}: WhiteboardProps) {
  const { language: contextLanguage } = useLanguage();
  const language = propLanguage || contextLanguage;
  
  if (items.length === 0) {
    return null;
  }
  
  return (
    <div 
      className="flex flex-col gap-2"
      data-testid="panel-whiteboard-content"
    >
      <AnimatePresence mode="sync">
        {items.map((item, index) => (
          <WhiteboardItemDisplay 
            key={item.id || `${item.type}-${item.content}-${index}`} 
            item={item} 
            index={index}
            onDrillResponse={onDrillResponse}
            onDrillStart={onDrillStart}
            onDrillComplete={onDrillComplete}
            onTextInputSubmit={onTextInputSubmit}
            language={language}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Compact whiteboard variant for inline display
 * Used when whiteboard should appear within the chat flow
 */
export function InlineWhiteboard({ 
  items,
  onDrillResponse,
  onDrillStart,
  onTextInputSubmit,
  language: propLanguage,
}: { 
  items: WhiteboardItem[];
  onDrillResponse?: (drillId: string, response: string) => void;
  onDrillStart?: (drillId: string) => void;
  onTextInputSubmit?: (itemId: string, response: string) => void;
  language?: string;
}) {
  const { language: contextLanguage } = useLanguage();
  const language = propLanguage || contextLanguage;
  
  if (items.length === 0) {
    return null;
  }
  
  return (
    <div 
      className="my-3 rounded-lg border border-border bg-muted/50 p-3"
      data-testid="inline-whiteboard"
    >
      <div className="flex flex-col gap-2">
        {items.map((item, index) => (
          <WhiteboardItemDisplay 
            key={item.id || `${item.type}-${item.content}-${index}`} 
            item={item} 
            index={index}
            onDrillResponse={onDrillResponse}
            onDrillStart={onDrillStart}
            onTextInputSubmit={onTextInputSubmit}
            language={language}
          />
        ))}
      </div>
    </div>
  );
}
