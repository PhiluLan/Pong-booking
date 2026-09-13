import AdminApp from "@/components/AdminApp";
import BookingPage from "./buchen/page";

export default function Home() {
  return process.env.NEXT_PUBLIC_APP_SURFACE === "team" ? (
    <AdminApp />
  ) : (
    <BookingPage />
  );
}
