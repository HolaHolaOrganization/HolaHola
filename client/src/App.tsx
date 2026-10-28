import { lazy, Suspense, useEffect, useRef } from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ErrorBoundary, WidgetErrorBoundary } from "@/components/ErrorBoundary";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { LearningFilterProvider } from "@/contexts/LearningFilterContext";
import { UsageProvider } from "@/contexts/UsageContext";
import { useAuth } from "@/hooks/useAuth";
import { useLogout } from "@/hooks/useLogout";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { UserCircle, Settings as SettingsIcon, LogOut, Loader2, Menu } from "lucide-react";
import { Link } from "wouter";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { SystemAlertBanner } from "@/components/SystemAlertBanner";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PendingJoinCodeHandler } from "@/components/PendingJoinCodeHandler";
import { BUILD_TIME } from "./buildtime";
import { TermsGate } from "@/components/TermsGate";
import { DanielaSessionProvider } from "@/contexts/DanielaSessionContext";

function lazyWithRetry(importFn: () => Promise<any>, retries = 3, delay = 1500) {
  return lazy(() => {
    return new Promise((resolve, reject) => {
      function attempt(left: number) {
        importFn().then(resolve).catch((err: any) => {
          if (left > 0) {
            console.log(`[LazyLoad] Import failed, retrying in ${delay}ms (${left} left)...`);
            setTimeout(() => attempt(left - 1), delay);
          } else {
            reject(err);
          }
        });
      }
      attempt(retries);
    });
  });
}

const Landing = lazyWithRetry(() => import("@/pages/Landing"));
const Onboarding = lazyWithRetry(() => import("@/pages/onboarding"));
const Dashboard = lazyWithRetry(() => import("@/pages/dashboard"));
const CentralRecords = lazyWithRetry(() => import("@/pages/CentralRecords"));
const Chat = lazyWithRetry(() => import("@/pages/chat"));
const ChatIdeas = lazyWithRetry(() => import("@/pages/chat-ideas"));
const CulturalTips = lazyWithRetry(() => import("@/pages/cultural-tips"));
const Vocabulary = lazyWithRetry(() => import("@/pages/vocabulary"));
const Grammar = lazyWithRetry(() => import("@/pages/grammar"));
const History = lazyWithRetry(() => import("@/pages/history"));
const CanDoProgress = lazyWithRetry(() => import("@/pages/can-do-progress"));
const Settings = lazyWithRetry(() => import("@/pages/settings"));
const TeacherDashboard = lazyWithRetry(() => import("@/pages/teacher-dashboard"));
const ClassManagement = lazyWithRetry(() => import("@/pages/class-management"));
const AssignmentCreator = lazyWithRetry(() => import("@/pages/assignment-creator"));
const AssignmentGrading = lazyWithRetry(() => import("@/pages/assignment-grading"));
const StudentJoinClass = lazyWithRetry(() => import("@/pages/student-join-class"));
const StudentAssignments = lazyWithRetry(() => import("@/pages/student-assignments"));
const CurriculumBuilder = lazyWithRetry(() => import("@/pages/curriculum-builder"));
const CurriculumLibrary = lazyWithRetry(() => import("@/pages/curriculum-library"));
const ClassCreationHub = lazyWithRetry(() => import("@/pages/class-creation-hub"));
const CommandCenter = lazyWithRetry(() => import("@/pages/admin/CommandCenter"));
const RuntimeOnboarding = lazyWithRetry(() => import("@/pages/admin/RuntimeOnboarding"));
const MissionControl = lazyWithRetry(() => import("@/pages/admin/MissionControl"));
const AdminVoiceConsole = lazyWithRetry(() => import("@/pages/admin/VoiceConsole"));
const AdminNorthStar = lazyWithRetry(() => import("@/pages/admin/NorthStar"));
const AdminDeveloperDashboard = lazyWithRetry(() => import("@/pages/admin/DeveloperDashboard"));
const AdminBrainHealth = lazyWithRetry(() => import("@/pages/admin/BrainHealth"));
const AdminSessionEconomics = lazyWithRetry(() => import("@/pages/admin/SessionEconomics"));
const AdminAICostMonitor = lazyWithRetry(() => import("@/pages/admin/AICostMonitor"));
const AdminCallQuality = lazyWithRetry(() => import("@/pages/admin/CallQuality"));
const AdminLiveMonitor = lazyWithRetry(() => import("@/pages/admin/LiveMonitor"));
const AdminImageEngineTest = lazyWithRetry(() => import("@/pages/admin/ImageEngineTest"));
const AgentVisualTest = lazyWithRetry(() => import("@/pages/agent-visual-test"));
const DanielaDiary = lazyWithRetry(() => import("@/pages/daniela-diary"));
const Lessons = lazyWithRetry(() => import("@/pages/lessons"));
const LanguageHub = lazyWithRetry(() => import("@/pages/language-hub"));
const ReviewHub = lazyWithRetry(() => import("@/pages/review-hub"));
const ArisPractice = lazyWithRetry(() => import("@/pages/aris-practice"));
const ScenarioBrowser = lazyWithRetry(() => import("@/pages/scenario-browser"));
const PronunciationDrill = lazyWithRetry(() => import("@/pages/pronunciation-drill"));
const SessionReplay = lazyWithRetry(() => import("@/pages/session-replay"));
const InteractiveTextbook = lazyWithRetry(() => import("@/pages/interactive-textbook"));
const BiologyTutor = lazyWithRetry(() => import("@/pages/biology-tutor"));
const HistoryTutor = lazyWithRetry(() => import("@/pages/history-tutor"));
const MathTutor = lazyWithRetry(() => import("@/pages/math-tutor"));
const BusinessTutor = lazyWithRetry(() => import("@/pages/business-tutor"));
const AldenPage = lazyWithRetry(() => import("@/pages/alden"));
const AgentSpace = lazyWithRetry(() => import("@/pages/AgentSpace"));
const FineTuningCurator = lazyWithRetry(() => import("@/pages/fine-tuning-curator"));
const TeamRoom = lazyWithRetry(() => import("@/pages/TeamRoom"));
const StudyMode = lazyWithRetry(() => import("@/pages/StudyMode"));
const ReadingLibrary = lazyWithRetry(() => import("@/pages/reading-library"));
const ProgressReport = lazyWithRetry(() => import("@/pages/progress-report"));
const VoiceMessage = lazyWithRetry(() => import("@/pages/voice-message"));
const NotFound = lazyWithRetry(() => import("@/pages/not-found"));

const Login = lazyWithRetry(() => import("@/pages/auth/Login"));
const Signup = lazyWithRetry(() => import("@/pages/auth/Signup"));
const GetStarted = lazyWithRetry(() => import("@/pages/auth/GetStarted"));
const Pricing = lazyWithRetry(() => import("@/pages/Pricing"));
const Classes = lazyWithRetry(() => import("@/pages/Classes"));
const ClassDetail = lazyWithRetry(() => import("@/pages/ClassDetail"));
const CompleteRegistration = lazyWithRetry(() => import("@/pages/auth/CompleteRegistration"));
const ForgotPassword = lazyWithRetry(() => import("@/pages/auth/ForgotPassword"));
const ResetPassword = lazyWithRetry(() => import("@/pages/auth/ResetPassword"));

// Closes sidebar when entering /chat, reopens when leaving
function SidebarRouteController() {
  const [location] = useLocation();
  const { setOpen } = useSidebar();
  // Keep a ref so the effect always calls the latest setOpen without re-triggering
  // when setOpen's reference changes (it recreates on every open/close state change).
  const setOpenRef = useRef(setOpen);
  useEffect(() => { setOpenRef.current = setOpen; });

  useEffect(() => {
    setOpenRef.current(location !== "/chat");
  }, [location]);
  return null;
}

// Loading fallback component
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

// ScrollToTop component to reset scroll position on route changes
function ScrollToTop() {
  const [pathname] = useLocation();

  useEffect(() => {
    // Standard window scroll for most cases
    window.scrollTo(0, 0);
    
    // Also target the scrollable container in PageWrapper if it exists
    const scrollContainer = document.querySelector('.overflow-y-auto');
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }, [pathname]);

  return null;
}

// Wrapper component that adds container padding for non-chat pages
function PageWrapper({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  
  // Only chat page is full-height for authenticated users
  // Landing page (/) is full-height for unauthenticated users
  const isFullHeightPage = location === "/chat" || location === "/team-room" || location === "/admin/mission" || location === "/study-mode" || location === "/alden" || location === "/agent-space" || (!isAuthenticated && !isLoading && location === "/");

  const content = (
    <Suspense fallback={<PageLoader />}>
      {children}
    </Suspense>
  );

  if (isFullHeightPage) {
    return <div className="flex flex-col h-full">{content}</div>;
  }

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto">
      <div className="w-full max-w-full px-4 py-6 md:px-8 mx-auto md:max-w-7xl overflow-hidden">
        {content}
      </div>
    </div>
  );
}

// Replit Auth Integration - Router with authentication check
function Router() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const [currentPath, setLocation] = useLocation();

  useEffect(() => {
    console.log(`[Router] Render: path=${currentPath}, auth=${isAuthenticated}, loading=${isLoading}`);
  }, [currentPath, isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      sessionStorage.setItem("holahola_session_started", "1");
    }
  }, [isLoading, isAuthenticated]);

  // Show loading screen while checking authentication
  if (isLoading) {
    return <PageLoader />;
  }

  // For unauthenticated users, show landing page and auth routes
  if (!isAuthenticated) {
    return (
      <PageWrapper>
        <ScrollToTop />
        <Switch>
          <Route path="/" component={Landing} />
          <Route path="/get-started" component={GetStarted} />
          <Route path="/login" component={Login} />
          <Route path="/signup" component={Signup} />
          <Route path="/pricing" component={Pricing} />
          <Route path="/classes" component={Classes} />
          <Route path="/classes/:id" component={ClassDetail} />
          <Route path="/complete-registration" component={CompleteRegistration} />
          <Route path="/forgot-password" component={ForgotPassword} />
          <Route path="/reset-password" component={ResetPassword} />
          <Route path="/vm/:id" component={VoiceMessage} />
          <Route component={NotFound} />
        </Switch>
      </PageWrapper>
    );
  }

  // For authenticated users, always define all routes
  // ReviewHub is the main landing page (Language Hub)
  return (
    <>
    {/* ToS gate — shown as overlay when user hasn't accepted yet */}
    {user && !user.tosAcceptedAt && <TermsGate>{null}</TermsGate>}
    <PageWrapper>
      <ScrollToTop />
      <Switch>
        <Route path="/" component={LanguageHub} />
        <Route path="/dashboard" component={ReviewHub} />
        <Route path="/legacy-dashboard" component={Dashboard} />
        <Route path="/admin/records/:id" component={CentralRecords} />
        <Route path="/admin/records" component={CentralRecords} />
        <Route path="/onboarding" component={Onboarding} />
        <Route path="/chat" component={Chat} />
        {/* Voice tutor route aliases - all redirect to /chat */}
        <Route path="/voice-tutor"><Redirect to="/chat" /></Route>
        <Route path="/voice"><Redirect to="/chat" /></Route>
        <Route path="/tutor"><Redirect to="/chat" /></Route>
        <Route path="/chat-ideas" component={ChatIdeas} />
        <Route path="/cultural-tips" component={CulturalTips} />
        <Route path="/vocabulary" component={Vocabulary} />
        <Route path="/grammar" component={Grammar} />
        <Route path="/history" component={History} />
        <Route path="/can-do-progress" component={CanDoProgress} />
        <Route path="/lessons" component={Lessons} />
        <Route path="/practice">{() => <WidgetErrorBoundary name="Practice"><ArisPractice /></WidgetErrorBoundary>}</Route>
        <Route path="/scenarios" component={ScenarioBrowser} />
        <Route path="/aris">{() => <WidgetErrorBoundary name="Practice"><ArisPractice /></WidgetErrorBoundary>}</Route>
        <Route path="/pronunciation">{() => <WidgetErrorBoundary name="Pronunciation"><PronunciationDrill /></WidgetErrorBoundary>}</Route>
        <Route path="/pronunciation-drill">{() => <WidgetErrorBoundary name="Pronunciation"><PronunciationDrill /></WidgetErrorBoundary>}</Route>
        <Route path="/session-replay" component={SessionReplay} />
        <Route path="/interactive-textbook" component={InteractiveTextbook} />
        <Route path="/biology" component={BiologyTutor} />
        <Route path="/history-tutor" component={HistoryTutor} />
        <Route path="/math-tutor" component={MathTutor} />
        <Route path="/business-tutor" component={BusinessTutor} />
        <Route path="/reading-library" component={ReadingLibrary} />
        <Route path="/progress-report" component={ProgressReport} />
        <Route path="/alden" component={AldenPage} />
        <Route path="/agent-space" component={AgentSpace} />
        <Route path="/fine-tuning" component={FineTuningCurator} />
        <Route path="/team-room" component={TeamRoom} />
        <Route path="/study-mode" component={StudyMode} />
        <Route path="/diary" component={DanielaDiary} />
        
        {/* Teacher Routes - Protected */}
        <Route path="/teacher/dashboard" component={TeacherDashboard} />
        <Route path="/teacher" component={TeacherDashboard} />
        <Route path="/teacher/classes/:classId" component={ClassManagement} />
        <Route path="/teacher/assignments/new" component={AssignmentCreator} />
        <Route path="/teacher/assignments/create" component={AssignmentCreator} />
        <Route path="/teacher/assignments/:assignmentId/grade" component={AssignmentGrading} />
        <Route path="/teacher/create-class" component={ClassCreationHub} />
        <Route path="/teacher/curriculum" component={CurriculumLibrary} />
        <Route path="/teacher/curriculum/builder" component={CurriculumBuilder} />
        
        {/* Student Routes */}
        <Route path="/student/join-class" component={StudentJoinClass} />
        <Route path="/student/assignments" component={StudentAssignments} />
        
        {/* Admin Routes - specific paths before /admin catch-all */}
        <Route path="/admin/runtime-onboarding" component={RuntimeOnboarding} />
        <Route path="/admin/mission" component={MissionControl} />
        <Route path="/admin/voices" component={AdminVoiceConsole} />
        <Route path="/admin/north-star" component={AdminNorthStar} />
        <Route path="/admin/developer" component={AdminDeveloperDashboard} />
        <Route path="/admin/brain-health" component={AdminBrainHealth} />
        <Route path="/admin/session-economics" component={AdminSessionEconomics} />
        <Route path="/admin/ai-costs" component={AdminAICostMonitor} />
        <Route path="/admin/calls" component={AdminCallQuality} />
        <Route path="/admin/live-monitor" component={AdminLiveMonitor} />
        <Route path="/admin/image-test" component={AdminImageEngineTest} />
        <Route path="/admin/visual-test" component={AgentVisualTest} />
        <Route path="/admin" component={CommandCenter} />
        
        <Route path="/settings" component={Settings} />
        <Route path="/pricing" component={Pricing} />
        <Route path="/classes" component={Classes} />
        <Route path="/classes/:id" component={ClassDetail} />
        
        {/* Auth routes - accessible even when logged in for account management */}
        <Route path="/complete-registration" component={CompleteRegistration} />
        <Route path="/login"><Redirect to="/" /></Route>
        <Route path="/signup"><Redirect to="/" /></Route>
        
        <Route path="/vm/:id" component={VoiceMessage} />
        <Route component={NotFound} />
      </Switch>
    </PageWrapper>
    </>
  );
}

function App() {
  const style = {
    "--sidebar-width": "18rem",
    "--sidebar-width-icon": "4rem",
  };

  // Force cache bust
  console.log('[BUILD] App version:', BUILD_TIME);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthenticatedApp style={style} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

// Separate authenticated app component to use auth hooks
function AuthenticatedApp({ style }: { style: { [key: string]: string } }) {
  const { isAuthenticated, isLoading } = useAuth();

  // Show landing page for unauthenticated users
  if (isLoading || !isAuthenticated) {
    return <Router />;
  }

  // Show full app with sidebar for authenticated users
  return (
    <LanguageProvider>
      <UsageProvider>
        <LearningFilterProvider>
          <DanielaSessionProvider>
            <PendingJoinCodeHandler />
            <SidebarProvider defaultOpen={typeof window !== 'undefined' ? window.location.pathname !== '/chat' : true} style={style as React.CSSProperties}>
              <SidebarRouteController />
              <div className="flex h-screen w-full max-w-full overflow-hidden">
                {/* Sidebar renders as Sheet overlay on mobile, regular sidebar on desktop */}
                <AppSidebar />
                <div className="flex flex-col flex-1 relative min-w-0 overflow-hidden">
                  <main className="flex-1 overflow-x-hidden overflow-y-auto relative">
                    <Router />
                  </main>
                  {/* Floating menu button - bottom-left */}
                  <FloatingMenuButton />
                </div>
              </div>
              <OfflineIndicator />
              <SystemAlertBanner />
              <PWAInstallPrompt />
            </SidebarProvider>
          </DanielaSessionProvider>
        </LearningFilterProvider>
      </UsageProvider>
    </LanguageProvider>
  );
}

// Floating menu button - works on all screen sizes
// Uses fixed positioning with safe area insets for mobile devices
function FloatingMenuButton() {
  const { toggleSidebar } = useSidebar();
  const [location] = useLocation();
  // Chat page manages its own full-screen layout — sidebar toggle would overlap the Studio pane
  if (location === '/chat') return null;
  
  return (
    <Button
      variant="outline"
      size="icon"
      className="fixed z-50 h-12 w-12 rounded-full shadow-lg bg-background border-2 bottom-20 sm:bottom-4 left-[max(1rem,env(safe-area-inset-left))]"
      onClick={toggleSidebar}
      data-testid="button-toggle-sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  );
}

function UserMenu() {
  const { user } = useAuth();
  const logoutMutation = useLogout();

  if (!user) return null;

  const initials = user.firstName && user.lastName
    ? `${user.firstName[0]}${user.lastName[0]}`.toUpperCase()
    : user.firstName
    ? user.firstName[0].toUpperCase()
    : user.email?.[0]?.toUpperCase() || "U";

  const displayName = user.firstName
    ? user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName
    : user.email || "User";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 md:h-10 w-8 md:w-10 rounded-full" data-testid="button-user-menu">
          <Avatar className="h-8 md:h-10 w-8 md:w-10">
            {user.profileImageUrl && <AvatarImage src={user.profileImageUrl} alt={displayName} />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium" data-testid="text-user-name">{displayName}</p>
            {user.email && (
              <p className="text-xs text-muted-foreground" data-testid="text-user-email">{user.email}</p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild data-testid="menu-item-settings">
          <Link href="/settings">
            <SettingsIcon className="mr-2 h-4 w-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem 
          onClick={() => logoutMutation.mutate()} 
          disabled={logoutMutation.isPending}
          data-testid="menu-item-logout"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {logoutMutation.isPending ? "Signing out..." : "Sign Out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default App;
