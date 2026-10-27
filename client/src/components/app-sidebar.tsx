import { useState } from "react";
import { BookOpen, Languages, History, Settings, Lightbulb, LogOut, Globe, Award, GraduationCap, Shield, X, Target, Search, Sparkles, HelpCircle, MapPin, Microscope, Landmark, Library, ClipboardList, FlaskConical, Calculator, Atom, BookMarked, Telescope, Leaf, TrendingUp, Building2, Users, Briefcase, BrainCircuit, Compass, ScrollText, Phone } from "lucide-react";
import holaholaLogo from "@assets/holaholamainlogoBackgroundRemoved_1765308837223.png";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StreakIndicator } from "@/components/StreakIndicator";
import { UsageIndicator } from "@/components/UpgradePrompt";
import { SupportAssistModal } from "@/components/SupportAssistModal";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/hooks/useAuth";
import { useLogout } from "@/hooks/useLogout";
import { hasTeacherAccess, hasAdminAccess } from "@shared/permissions";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import type { SubjectSyllabus } from "@shared/schema";
import type { LucideIcon } from "lucide-react";

const dashboardItem = { title: "Language Hub", url: "/", icon: Target };

const libraryMenuItems = [
  { title: "Scenarios", url: "/scenarios", icon: MapPin },
  { title: "Study Mode", url: "/study-mode", icon: BookMarked },
  { title: "Vocabulary", url: "/vocabulary", icon: BookOpen },
  { title: "Grammar", url: "/grammar", icon: Languages },
  { title: "Past Chats", url: "/history", icon: History },
  { title: "Can-Do Progress", url: "/can-do-progress", icon: Award },
  { title: "Daniela's Diary", url: "/diary", icon: ScrollText },
];

const resourceMenuItems = [
  { title: "Find a Class", url: "/student/join-class", icon: Search },
  { title: "Cultural Tips", url: "/cultural-tips", icon: Globe },
  { title: "Chat Ideas", url: "/chat-ideas", icon: Lightbulb },
];

const teacherMenuItems = [
  { title: "My Classes", url: "/teacher/dashboard", icon: GraduationCap },
  { title: "Class Creation Hub", url: "/teacher/create-class", icon: Sparkles },
];

const adminMenuItems = [
  { title: "Command Center", url: "/admin", icon: Shield },
  { title: "Episode Archive", url: "/admin/records", icon: Library },
  { title: "Call Quality", url: "/admin/calls", icon: Phone },
];

const TOOLS_ITEMS = [
  { title: "Reading Library", url: "/reading-library", icon: Library },
  { title: "Progress Report", url: "/progress-report", icon: ClipboardList },
];

type SubjectConfig = {
  icon: LucideIcon;
  tutorPath?: string;
  tutorLabel?: string;
};

const SUBJECT_CONFIG: Record<string, SubjectConfig> = {
  // Natural Sciences — life sciences share Microscope, physics share Atom
  biology:                   { icon: Microscope, tutorPath: "/biology",       tutorLabel: "Biology — Evelyn / Gene" },
  microbiology:              { icon: Microscope },
  "anatomy-physiology":      { icon: Microscope },
  nutrition:                 { icon: Leaf },
  chemistry:                 { icon: FlaskConical },
  "university-physics-vol1": { icon: Atom },
  "university-physics-vol2": { icon: Atom },
  "university-physics-vol3": { icon: Atom },
  "college-physics":         { icon: Atom },
  astronomy:                 { icon: Telescope },

  // Mathematics — all link to Math tutor (Ada / Leo)
  prealgebra:                { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "elementary-algebra":      { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "college-algebra":         { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  precalculus:               { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "calculus-vol1":           { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "calculus-vol2":           { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "calculus-vol3":           { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  statistics:                { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },
  "contemporary-math":       { icon: Calculator, tutorPath: "/math-tutor", tutorLabel: "Mathematics — Ada / Leo" },

  // Social Studies — history shares Landmark, econ shares TrendingUp
  history:                   { icon: Landmark, tutorPath: "/history-tutor", tutorLabel: "History — Clio / Marcus" },
  "world-history-vol1":      { icon: Landmark },
  "world-history-vol2":      { icon: Landmark },
  "american-government":     { icon: Building2 },
  "introduction-sociology":  { icon: Users },
  psychology:                { icon: Users },
  macroeconomics:            { icon: TrendingUp },
  microeconomics:            { icon: TrendingUp },
  philosophy:                { icon: Lightbulb },

  // Business — all link to Business tutor (Morgan / Sterling)
  "principles-management":       { icon: Briefcase, tutorPath: "/business-tutor", tutorLabel: "Business — Morgan / Sterling" },
  "principles-accounting-vol1":  { icon: Briefcase, tutorPath: "/business-tutor", tutorLabel: "Business — Morgan / Sterling" },
  "principles-finance":          { icon: Briefcase, tutorPath: "/business-tutor", tutorLabel: "Business — Morgan / Sterling" },
  entrepreneurship:              { icon: Briefcase, tutorPath: "/business-tutor", tutorLabel: "Business — Morgan / Sterling" },
  "business-ethics":             { icon: Briefcase, tutorPath: "/business-tutor", tutorLabel: "Business — Morgan / Sterling" },
};

const SUBJECT_TO_CATEGORY: Record<string, string> = {
  biology:                  "Natural Sciences",
  microbiology:             "Natural Sciences",
  "anatomy-physiology":     "Natural Sciences",
  chemistry:                "Natural Sciences",
  "university-physics-vol1":"Natural Sciences",
  "university-physics-vol2":"Natural Sciences",
  "university-physics-vol3":"Natural Sciences",
  "college-physics":        "Natural Sciences",
  astronomy:                "Natural Sciences",
  nutrition:                "Natural Sciences",
  prealgebra:               "Mathematics",
  "elementary-algebra":     "Mathematics",
  "college-algebra":        "Mathematics",
  precalculus:              "Mathematics",
  "calculus-vol1":          "Mathematics",
  "calculus-vol2":          "Mathematics",
  "calculus-vol3":          "Mathematics",
  statistics:               "Mathematics",
  "contemporary-math":      "Mathematics",
  history:                  "Social Studies",
  "world-history-vol1":     "Social Studies",
  "world-history-vol2":     "Social Studies",
  "american-government":    "Social Studies",
  "introduction-sociology": "Social Studies",
  psychology:               "Social Studies",
  macroeconomics:           "Social Studies",
  microeconomics:           "Social Studies",
  philosophy:               "Social Studies",
  "principles-management":      "Business",
  "principles-accounting-vol1": "Business",
  "principles-finance":         "Business",
  entrepreneurship:             "Business",
  "business-ethics":            "Business",
};

const SIDEBAR_CATEGORIES = [
  { key: "Natural Sciences", label: "Natural Sciences" },
  { key: "Mathematics",      label: "Mathematics" },
  { key: "Social Studies",   label: "Social Studies" },
  { key: "Business",         label: "Business" },
];

function getSubjectIcon(subject: string): LucideIcon {
  return SUBJECT_CONFIG[subject.toLowerCase()]?.icon ?? BookMarked;
}

function getSubjectLabel(subject: string, syllabus: SubjectSyllabus): string {
  return syllabus.bookTitle ?? subject.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function getSubjectUrl(subject: string): string {
  const cfg = SUBJECT_CONFIG[subject.toLowerCase()];
  return cfg?.tutorPath ?? `/reading-library?subject=${subject}`;
}

function AldenNavItem({ location, closeSidebar }: { location: string; closeSidebar: () => void }) {
  const { data } = useQuery<{ count: number }>({
    queryKey: ['/api/alden/notifications/unread-count'],
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const unread = data?.count ?? 0;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={location.startsWith('/alden')}
        data-testid="link-talk-to-alden"
      >
        <Link href="/alden" onClick={closeSidebar}>
          <BrainCircuit className="h-4 w-4" />
          <span className="flex-1">Talk to Alden</span>
          {unread > 0 && (
            <Badge
              variant="destructive"
              className="ml-auto text-xs h-5 min-w-5 flex items-center justify-center no-default-active-elevate"
              data-testid="badge-alden-unread"
            >
              {unread}
            </Badge>
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const [location] = useLocation();
  const { userName } = useLanguage();
  const { user } = useAuth();
  const { setOpenMobile, setOpen, isMobile } = useSidebar();
  const logoutMutation = useLogout();

  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportTicketId, setSupportTicketId] = useState<string | null>(null);
  const [isLoadingSupport, setIsLoadingSupport] = useState(false);

  const { data: syllabi = [] } = useQuery<SubjectSyllabus[]>({
    queryKey: ["/api/syllabi"],
    staleTime: 5 * 60 * 1000,
    enabled: !!user,
  });

  const handleOpenSupport = async () => {
    setIsLoadingSupport(true);
    try {
      const existingResponse = await apiRequest('GET', '/api/support/tickets?status=active');
      if (existingResponse.ok) {
        const existingTickets = await existingResponse.json();
        if (Array.isArray(existingTickets) && existingTickets.length > 0) {
          setSupportTicketId(existingTickets[0].id);
          setIsSupportOpen(true);
          closeSidebar();
          setIsLoadingSupport(false);
          return;
        }
      }
      const response = await apiRequest('POST', '/api/support/tickets', {
        category: 'other',
        subject: 'Help request from sidebar',
        description: 'User clicked Need Help from sidebar',
        handoffFrom: 'direct',
      });
      if (response.ok) {
        const data = await response.json();
        setSupportTicketId(data.id || null);
      }
      setIsSupportOpen(true);
      closeSidebar();
    } catch (err) {
      console.error('[Sidebar] Failed to open support:', err);
      setIsSupportOpen(true);
      closeSidebar();
    } finally {
      setIsLoadingSupport(false);
    }
  };

  const closeSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    } else {
      setOpen(false);
    }
  };

  const isOnboardingComplete = userName && userName.trim() !== "";
  const visibleResourceItems = resourceMenuItems.filter(item => {
    if (item.title === "Chat Ideas" && !isOnboardingComplete) return false;
    return true;
  });

  const isTeacher = hasTeacherAccess(user?.role);
  const isAdmin = hasAdminAccess(user?.role) || user?.role === 'developer';

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <img
              src={holaholaLogo}
              alt="HolaHola"
              className="h-20 w-20 object-contain -ml-3 -my-2"
              data-testid="img-logo"
            />
            <div>
              <h1 className="text-xl font-semibold">HolaHola</h1>
              <p className="text-sm text-muted-foreground">Learn & Practice</p>
            </div>
          </div>
          {isMobile && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpenMobile(false)}
              className="h-8 w-8"
              data-testid="button-close-sidebar"
            >
              <X className="h-5 w-5" />
            </Button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === dashboardItem.url}
                  data-testid="link-dashboard"
                >
                  <Link href={dashboardItem.url} onClick={closeSidebar}>
                    <dashboardItem.icon className="h-4 w-4" />
                    <span>{dashboardItem.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Languages</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {libraryMenuItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-${item.title.toLowerCase().replace(' ', '-')}`}
                    >
                      <Link href={item.url} onClick={closeSidebar}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {SIDEBAR_CATEGORIES.map(cat => {
          const catSyllabi = syllabi.filter(s => SUBJECT_TO_CATEGORY[s.subject] === cat.key && ((s as any).unitCount > 0));
          if (catSyllabi.length === 0) return null;
          return (
            <SidebarGroup key={cat.key}>
              <SidebarGroupLabel>{cat.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {catSyllabi.map(syllabus => {
                    const subject = syllabus.subject;
                    const url = getSubjectUrl(subject);
                    const label = getSubjectLabel(subject, syllabus);
                    const Icon = getSubjectIcon(subject);
                    const isActive = location === url || location.startsWith(url.split('?')[0]);
                    return (
                      <SidebarMenuItem key={subject}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          data-testid={`link-subject-${subject}`}
                        >
                          <Link href={url} onClick={closeSidebar}>
                            <Icon className="h-4 w-4" />
                            <span>{label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}

        <SidebarGroup>
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {TOOLS_ITEMS.map((item) => {
                const isActive = location.startsWith(item.url.split('?')[0]);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-${item.title.toLowerCase().replace(/[\s—]+/g, '-')}`}
                    >
                      <Link href={item.url} onClick={closeSidebar}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {isAdmin && (
                <AldenNavItem location={location} closeSidebar={closeSidebar} />
              )}
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.startsWith('/agent-space')}
                    data-testid="link-agent-space"
                  >
                    <Link href="/agent-space" onClick={closeSidebar}>
                      <Compass className="h-4 w-4" />
                      <span>Agent Space</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              {isAdmin && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.startsWith('/team-room')}
                    data-testid="link-team-room"
                  >
                    <Link href="/team-room" onClick={closeSidebar}>
                      <Users className="h-4 w-4" />
                      <span>Team Room</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleResourceItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`link-${item.title.toLowerCase().replace(' ', '-')}`}
                    >
                      <Link href={item.url} onClick={closeSidebar}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isTeacher && (
          <SidebarGroup>
            <SidebarGroupLabel>Teaching</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {teacherMenuItems.map((item) => {
                  const isActive = location === item.url;
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <Link href={item.url} onClick={closeSidebar}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {(isAdmin || isTeacher) && (
          <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminMenuItems.map((item) => {
                  const isActive = location === item.url || location.startsWith(item.url + '/');
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <Link href={item.url} onClick={closeSidebar}>
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="p-6 space-y-4">
        <div className="px-2 space-y-2">
          <StreakIndicator compact />
          <UsageIndicator />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleOpenSupport}
              disabled={isLoadingSupport}
              data-testid="button-need-help"
            >
              <HelpCircle className="h-4 w-4" />
              <span>{isLoadingSupport ? 'Opening...' : 'Need Help?'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild data-testid="link-settings">
              <Link href="/settings" onClick={closeSidebar}>
                <Settings className="h-4 w-4" />
                <span>Account</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                closeSidebar();
                logoutMutation.mutate();
              }}
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SupportAssistModal
        isOpen={isSupportOpen}
        onClose={() => setIsSupportOpen(false)}
        onResolved={() => {
          setIsSupportOpen(false);
          setSupportTicketId(null);
        }}
        ticketId={supportTicketId}
        category="other"
        reason="General help request"
        priority="normal"
        mode="support"
      />
    </Sidebar>
  );
}
