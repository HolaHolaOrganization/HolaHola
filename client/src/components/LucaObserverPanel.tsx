import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronLeft, ChevronRight, Send, Loader2, Zap, Eye, AlertTriangle, MessageSquare, Code2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest } from "@/lib/queryClient";

interface LucaObserverPanelProps {
  isOpen: boolean;
  onToggle: () => void;
  sessionId?: string | null;
}

interface ObserveResponse {
  status?: string;
  conversationId?: string;
  language?: string;
  actflLevel?: string;
  exchangeCount?: number;
  sceneEnvironment?: string | null;
  sceneVisionDescription?: string | null;
  recentToolCalls?: Array<{ name: string; secsAgo: number; note?: string }>;
  recentMessages?: Array<{ role: string; content: string; at?: string }>;
  guardianAB?: {
    globalChannel?: string;
    recentFires?: Array<{ ts: string; path: string; phrase: string; outcome?: string | null }>;
    heardCount?: number;
    missedCount?: number;
  };
  frictionHistory?: Array<{ score: number; label: string; turnId?: string; secsAgo?: number; smoothSlide?: boolean }>;
  recentMemorySearches?: Array<{ query: string; tool?: string; resultCount?: number }>;
  turnSummaries?: Array<{ turn: number; tools: string[]; hasArchiveCall: boolean; secsAgo: number }>;
}

interface DevNote {
  id: string;
  subject: string;
  body: string;
  createdAt: string;
}

export function LucaObserverPanel({ isOpen, onToggle, sessionId }: LucaObserverPanelProps) {
  const [noteText, setNoteText] = useState("");
  const qc = useQueryClient();

  const { data: obs, isFetching } = useQuery<ObserveResponse | null>({
    queryKey: ["/api/admin/luca/observe"],
    queryFn: async () => {
      const res = await fetch("/api/admin/luca/observe");
      if (!res.ok) return null;
      return res.json();
    },
    // Always poll — fast when open, slow when collapsed so we can show an alert dot
    refetchInterval: isOpen ? 5000 : 15000,
    staleTime: 4000,
    enabled: true,
  });

  const { data: devNotes } = useQuery<DevNote[]>({
    queryKey: ["/api/admin/luca/dev-notes"],
    queryFn: async () => {
      const res = await fetch("/api/admin/luca/dev-notes");
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: isOpen ? 10000 : false,
    enabled: isOpen,
  });

  const submitNote = useMutation({
    mutationFn: async (note: string) => {
      await apiRequest("POST", "/api/admin/luca/dev-note", {
        note,
        sessionId: sessionId ?? obs?.conversationId,
      });
    },
    onSuccess: () => {
      setNoteText("");
      qc.invalidateQueries({ queryKey: ["/api/admin/luca/dev-notes"] });
    },
  });

  const hasActiveSession = obs?.status === "active";
  // Arrays are oldest-first; last item = most recent
  const latestTool = obs?.recentToolCalls?.[0]; // recentToolCalls is newest-first in the endpoint
  const latestFriction = obs?.frictionHistory?.[obs.frictionHistory.length - 1];
  const recentMessages = obs?.recentMessages?.slice(-3) ?? [];
  const guardianFires = obs?.guardianAB?.recentFires?.length ?? 0;

  // Alert conditions: Guardian fired, HIGH friction, or frictionless slide detected
  const hasGuardianAlert = guardianFires > 0;
  const hasFrictionAlert = latestFriction?.label === "HIGH" || latestFriction?.smoothSlide === true;
  const hasAlert = hasActiveSession && (hasGuardianAlert || hasFrictionAlert);

  const frictionColor = !latestFriction ? "text-muted-foreground"
    : latestFriction.label === "HIGH" ? "text-orange-500"
    : latestFriction.label === "SMOOTH" ? "text-blue-500"
    : "text-green-500";

  return (
    <div className={`border-l bg-muted/30 flex flex-col transition-all duration-200 min-h-0 ${isOpen ? "w-72" : "w-10"}`}>
      {/* Toggle button — shows alert dot when collapsed and something notable is happening */}
      <button
        onClick={onToggle}
        className="relative flex items-center justify-center h-10 border-b hover:bg-muted/50 transition-colors"
        title={
          isOpen
            ? "Collapse Luca panel"
            : hasAlert
              ? `Luca sees something — ${hasGuardianAlert ? `${guardianFires} guardian fire${guardianFires !== 1 ? "s" : ""}` : ""}${hasGuardianAlert && hasFrictionAlert ? ", " : ""}${hasFrictionAlert ? `friction ${latestFriction?.label}` : ""}`
              : "Expand Luca panel"
        }
      >
        {isOpen ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        {!isOpen && hasAlert && (
          <span className="absolute top-2 right-1.5 h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
        )}
      </button>

      {isOpen && (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Header */}
          <div className="p-3 border-b flex items-center gap-2 shrink-0">
            <div className="relative">
              <Bot className="h-4 w-4 text-violet-500" />
              <span className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${hasActiveSession ? "bg-green-500" : "bg-muted-foreground"}`} />
            </div>
            <span className="font-medium text-sm">Luca</span>
            {isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />}
          </div>

          <ScrollArea className="flex-1">
            <div className="p-3 space-y-4">
              {/* Live session snapshot */}
              {hasActiveSession && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Now</p>

                  {obs?.sceneEnvironment && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Eye className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate text-muted-foreground">{obs.sceneEnvironment}</span>
                    </div>
                  )}

                  {latestTool && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Zap className="h-3 w-3 text-amber-500 shrink-0" />
                      <span className="truncate font-mono text-amber-700 dark:text-amber-400">{latestTool.name}</span>
                    </div>
                  )}

                  {latestFriction && (
                    <div className={`flex items-center gap-1.5 text-xs ${frictionColor}`}>
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>Last friction reading{latestFriction.turnId != null ? ` (turn ${latestFriction.turnId})` : ""}: {latestFriction.label} ({latestFriction.score?.toFixed?.(2) ?? latestFriction.score})</span>
                    </div>
                  )}

                  {guardianFires > 0 && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1 border-orange-400 text-orange-600">
                      {guardianFires} guardian {guardianFires === 1 ? "fire" : "fires"}
                    </Badge>
                  )}
                </div>
              )}

              {/* Recent transcript */}
              {recentMessages.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent</p>
                  {recentMessages.map((m, i) => (
                    <div key={i} className="text-[11px] leading-snug">
                      <span className={`font-semibold ${m.role === "assistant" ? "text-violet-600 dark:text-violet-400" : "text-foreground"}`}>
                        {m.role === "assistant" ? "Daniela" : "Student"}:
                      </span>{" "}
                      <span className="text-muted-foreground line-clamp-2">{m.content}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Memory searches */}
              {(obs?.recentMemorySearches?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Memory</p>
                  {obs!.recentMemorySearches!.slice(-2).map((s, i) => (
                    <div key={i} className="text-[11px] text-muted-foreground truncate">
                      → {s.query}
                    </div>
                  ))}
                </div>
              )}

              {/* Dev notes */}
              {(devNotes?.length ?? 0) > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <Code2 className="h-3 w-3" /> Dev Notes
                  </p>
                  {devNotes!.slice(-3).map((n) => (
                    <div key={n.id} className="rounded bg-violet-50 dark:bg-violet-950/30 p-1.5 text-[11px]">
                      <p className="font-medium text-violet-700 dark:text-violet-300 truncate">{n.subject}</p>
                      <p className="text-muted-foreground line-clamp-2 mt-0.5">{n.body}</p>
                    </div>
                  ))}
                </div>
              )}

              {!hasActiveSession && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No active session
                </p>
              )}
            </div>
          </ScrollArea>

          {/* Dev note input */}
          <div className="p-2 border-t shrink-0">
            <p className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-1">
              <MessageSquare className="h-3 w-3" /> Flag for Luca (dev note)
            </p>
            <div className="flex gap-1">
              <Input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Note something..."
                className="text-xs h-7"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && noteText.trim() && !submitNote.isPending) {
                    submitNote.mutate(noteText.trim());
                  }
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 shrink-0"
                    disabled={!noteText.trim() || submitNote.isPending}
                    onClick={() => submitNote.mutate(noteText.trim())}
                  >
                    {submitNote.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Send className="h-3 w-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send to Luca</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
