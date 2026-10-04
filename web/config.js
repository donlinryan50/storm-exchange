// Public settings for the browser. Fill these in from Supabase -> Project Settings -> API.
// The anon key is meant to be public: the row-level security rules in supabase/schema.sql decide what it can do.
// NEVER put the service_role key here (it bypasses all security and would be visible to everyone).
window.STORMEX_CONFIG = {
  supabaseUrl: "https://ojmugdbtbaajobfekowo.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qbXVnZGJ0YmFham9iZmVrb3dvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNTAwMTIsImV4cCI6MjEwNjcyNjAxMn0.pxBmyma1P-glHMI7N3n4kT4HoFn29dg5EHJ46F0xHn4"
};
