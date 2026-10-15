import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { Activity, LogOut } from "lucide-react";
import { useNavigate } from "react-router";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Authenticated workspace
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              Welcome{user?.name ? `, ${user.name}` : ""}
            </h1>
          </div>
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer gap-2 self-start"
            onClick={handleSignOut}
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </header>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Activity className="size-5" />
            </div>
            <CardTitle>Uptime monitoring</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm leading-6 text-muted-foreground">
            <p>
              Watch your websites around the clock. SitePulse checks each
              monitor from its own servers on your schedule, records uptime
              history, opens an incident only after two consecutive failed
              checks, and emails you on downtime and recovery.
            </p>
            <Button
              type="button"
              className="gap-2 self-start"
              onClick={() => navigate("/monitors")}
            >
              <Activity className="size-4" /> Open monitors
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
