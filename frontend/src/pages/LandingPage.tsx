import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";

import {
  ArrowRight,
  Briefcase,
  Code,
  FileText,
  HardDrive,
  LayoutDashboard,
  Lock,
  Menu,
  Moon,
  ShieldCheck,
  Sun,
  Users,
  X,
} from "lucide-react";

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(true);

  const [mousePosition, setMousePosition] = useState({
    x: 0,
    y: 0,
  });

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };

    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({
        x: e.clientX,
        y: e.clientY,
      });
    };

    window.addEventListener("scroll", handleScroll);
    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const fadeInUp = {
    hidden: {
      opacity: 0,
      y: 50,
    },

    visible: {
      opacity: 1,
      y: 0,

      transition: {
        duration: 0.8,
        ease: "easeOut",
      },
    },
  };

  const staggerContainer = {
    hidden: {},

    visible: {
      transition: {
        staggerChildren: 0.15,
      },
    },
  };

  return (
    <div
      className={`relative min-h-screen overflow-hidden font-['Inter'] transition-all duration-500 ${darkMode
          ? "bg-[#071426] text-white"
          : "bg-[#F2FFFA] text-[#2E2E2E]"
        }`}
    >
      {/* NOISE OVERLAY */}
      <div
        className="fixed inset-0 opacity-[0.03] pointer-events-none z-0"
        style={{
          backgroundImage:
            "url('https://grainy-gradients.vercel.app/noise.svg')",
        }}
      />

      {/* SPOTLIGHT */}
      <div
        className="pointer-events-none fixed inset-0 z-0 transition duration-300"
        style={{
          background: `radial-gradient(
            600px at ${mousePosition.x}px ${mousePosition.y}px,
            rgba(152,255,152,0.08),
            transparent 80%
          )`,
        }}
      />

      {/* BACKGROUND GLOWS */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-[#98FF98]/10 rounded-full blur-[120px]" />

        <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#0B3D91]/20 rounded-full blur-[140px]" />
      </div>

      {/* NAVBAR */}
      <nav
        className={`
          fixed
          top-5
          left-1/2
          -translate-x-1/2
          w-[95%]
          max-w-7xl
          z-50
          rounded-3xl
          border
          transition-all
          duration-500
          ${scrolled
            ? darkMode
              ? "bg-black/40 border-white/10 backdrop-blur-2xl shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
              : "bg-white/80 border-black/5 backdrop-blur-2xl shadow-xl"
            : darkMode
              ? "bg-white/5 border-white/5 backdrop-blur-xl"
              : "bg-white/50 border-black/5 backdrop-blur-xl"
          }
        `}
      >
        <div className="flex items-center justify-between px-6 py-4">
          {/* LOGO */}
          <Link to="/" className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#0B3D91] to-[#071426] flex items-center justify-center shadow-[0_10px_40px_rgba(11,61,145,0.5)]">
              <Briefcase className="w-6 h-6 text-[#98FF98]" />
            </div>

            <div>
              <div className="text-2xl font-black tracking-tight">
                KFive
              </div>

              <div className="text-xs opacity-60">
                Enterprise Infrastructure
              </div>
            </div>
          </Link>

          {/* DESKTOP NAV */}
          <div className="hidden md:flex items-center gap-10">
            {["Platform", "Features", "Security", "Infrastructure"].map(
              (item) => (
                <a
                  key={item}
                  href={`#${item.toLowerCase()}`}
                  className="relative font-medium hover:text-[#98FF98] transition"
                >
                  {item}
                </a>
              )
            )}
          </div>

          {/* ACTIONS */}
          <div className="hidden md:flex items-center gap-4">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-3 rounded-2xl border transition-all duration-300 ${darkMode
                  ? "bg-white/5 border-white/10 hover:bg-white/10"
                  : "bg-white border-black/10 hover:bg-black/5"
                }`}
            >
              {darkMode ? (
                <Sun className="w-5 h-5 text-yellow-400" />
              ) : (
                <Moon className="w-5 h-5 text-[#0B3D91]" />
              )}
            </button>

            <Link
              to="/login"
              className="font-medium hover:text-[#98FF98] transition"
            >
              Sign In
            </Link>

            <Link
              to="/register"
              className="
                group
                relative
                overflow-hidden
                px-7
                py-3
                rounded-2xl
                bg-[#0B3D91]
                font-semibold
                shadow-[0_10px_40px_rgba(11,61,145,0.5)]
                hover:scale-105
                transition-all
                duration-300
              "
            >
              <span className="relative z-10">
                Deploy Workspace
              </span>

              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-200%] group-hover:translate-x-[200%] transition-transform duration-1000" />
            </Link>
          </div>

          {/* MOBILE BUTTON */}
          <button
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X /> : <Menu />}
          </button>
        </div>

        {/* MOBILE MENU */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{
                opacity: 0,
                height: 0,
              }}
              animate={{
                opacity: 1,
                height: "auto",
              }}
              exit={{
                opacity: 0,
                height: 0,
              }}
              className={`md:hidden overflow-hidden border-t ${darkMode
                  ? "bg-[#071426]/95 border-white/10"
                  : "bg-white/95 border-black/5"
                } backdrop-blur-2xl`}
            >
              <div className="p-6 flex flex-col gap-5">
                <a href="#platform">Platform</a>
                <a href="#features">Features</a>
                <a href="#security">Security</a>

                <div className="flex gap-4 pt-4">
                  <Link
                    to="/login"
                    className="flex-1 py-3 rounded-2xl border border-white/10 text-center"
                  >
                    Login
                  </Link>

                  <Link
                    to="/register"
                    className="flex-1 py-3 rounded-2xl bg-[#0B3D91] text-center text-white"
                  >
                    Start
                  </Link>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* HERO */}
      <main className="relative z-10">
        <section className="relative max-w-7xl mx-auto px-6 pt-44 pb-36">
          {/* GRID */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff08_1px,transparent_1px),linear-gradient(to_bottom,#ffffff08_1px,transparent_1px)] bg-[size:60px_60px]" />

          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="relative z-10 text-center"
          >
            {/* BADGE */}
            <motion.div
              variants={fadeInUp}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-full border border-[#98FF98]/30 bg-white/5 backdrop-blur-xl text-[#98FF98] font-medium"
            >
              <ShieldCheck className="w-4 h-4" />
              Enterprise Infrastructure Platform
            </motion.div>

            {/* TITLE */}
            <motion.h1
              variants={fadeInUp}
              className="mt-10 text-7xl md:text-8xl lg:text-[9rem] font-black tracking-[-0.06em] leading-[0.9]"
            >
              Future Of
              <br />

              <span className="relative">
                Enterprise

                <span className="absolute inset-0 blur-3xl bg-[#98FF98]/20 -z-10" />
              </span>

              <br />

              <span className="bg-gradient-to-r from-[#98FF98] via-white to-[#0B3D91] bg-clip-text text-transparent">
                Infrastructure
              </span>
            </motion.h1>

            {/* DESCRIPTION */}
            <motion.p
              variants={fadeInUp}
              className={`mt-10 max-w-3xl mx-auto text-xl leading-relaxed ${darkMode
                  ? "text-gray-300"
                  : "text-gray-600"
                }`}
            >
              KFive unifies engineering workflows,
              enterprise collaboration, secure document
              intelligence, and private infrastructure into
              one beautifully engineered platform.
            </motion.p>

            {/* CTA */}
            <motion.div
              variants={fadeInUp}
              className="mt-12 flex flex-col sm:flex-row gap-5 justify-center"
            >
              <Link
                to="/register"
                className="
                  group
                  relative
                  overflow-hidden
                  px-9
                  py-5
                  rounded-2xl
                  bg-[#0B3D91]
                  text-white
                  font-semibold
                  shadow-[0_10px_40px_rgba(11,61,145,0.5)]
                  hover:scale-105
                  transition-all
                  duration-300
                  flex
                  items-center
                  justify-center
                "
              >
                <span className="relative z-10 flex items-center">
                  Launch Workspace

                  <ArrowRight className="w-5 h-5 ml-2" />
                </span>

                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-200%] group-hover:translate-x-[200%] transition-transform duration-1000" />
              </Link>

              <button
                className={`px-9 py-5 rounded-2xl border backdrop-blur-xl transition-all duration-300 hover:scale-105 ${darkMode
                    ? "border-white/10 bg-white/5 hover:bg-white/10"
                    : "border-black/10 bg-white hover:bg-gray-50"
                  }`}
              >
                Explore Platform
              </button>
            </motion.div>

            {/* STATS */}
            <motion.div
              variants={fadeInUp}
              className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-6"
            >
              {[
                ["99.99%", "Infrastructure Uptime"],
                ["256-bit", "Enterprise Encryption"],
                ["24/7", "Monitoring Systems"],
                ["0", "Telemetry Tracking"],
              ].map(([value, label]) => (
                <div
                  key={label}
                  className={`rounded-3xl border p-6 backdrop-blur-2xl ${darkMode
                      ? "bg-white/5 border-white/10"
                      : "bg-white/70 border-black/5"
                    }`}
                >
                  <div className="text-4xl font-black text-[#98FF98]">
                    {value}
                  </div>

                  <div className="mt-3 text-sm text-gray-400">
                    {label}
                  </div>
                </div>
              ))}
            </motion.div>
          </motion.div>
        </section>

        {/* DIVIDER */}
        <div className="w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* BENTO GRID */}
        <section
          id="platform"
          className="max-w-7xl mx-auto px-6 py-32"
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* LARGE CARD */}
            <motion.div
              whileHover={{
                y: -6,
              }}
              className="md:col-span-2 rounded-[36px] bg-gradient-to-br from-[#0B3D91] to-[#071426] p-10 border border-white/10 relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-[300px] h-[300px] bg-[#98FF98]/10 rounded-full blur-[100px]" />

              <div className="relative z-10">
                <div className="text-[#98FF98] text-sm uppercase tracking-[0.3em]">
                  Security Infrastructure
                </div>

                <h3 className="text-5xl font-black mt-6 leading-tight">
                  Enterprise-grade privacy architecture
                </h3>

                <p className="mt-8 text-gray-300 leading-relaxed text-lg">
                  Complete local execution with zero
                  external telemetry and fully isolated
                  infrastructure systems.
                </p>
              </div>
            </motion.div>

            {/* SMALL CARDS */}
            {[
              {
                icon: Code,
                title: "Integrated IDE",
              },

              {
                icon: FileText,
                title: "Document Engine",
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                whileHover={{
                  y: -8,
                }}
                className="
                  group
                  relative
                  overflow-hidden
                  rounded-[32px]
                  border
                  border-white/10
                  bg-white/[0.03]
                  backdrop-blur-2xl
                  p-8
                  hover:border-[#98FF98]/30
                  transition-all
                  duration-500
                "
              >
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition duration-500 bg-gradient-to-br from-[#98FF98]/10 via-transparent to-[#0B3D91]/10" />

                <item.icon className="w-12 h-12 text-[#98FF98] relative z-10" />

                <h4 className="mt-8 text-3xl font-black relative z-10">
                  {item.title}
                </h4>

                <p className="mt-4 text-gray-400 relative z-10">
                  Enterprise productivity systems optimized
                  for high-performance operations.
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* DASHBOARD */}
        <section className="max-w-7xl mx-auto px-6 pb-32">
          <motion.div
            initial={{
              opacity: 0,
              y: 80,
            }}
            whileInView={{
              opacity: 1,
              y: 0,
            }}
            viewport={{
              once: true,
            }}
            transition={{
              duration: 0.8,
            }}
            className="
              relative
              overflow-hidden
              rounded-[40px]
              border
              border-white/10
              bg-white/5
              backdrop-blur-3xl
              shadow-[0_20px_120px_rgba(0,0,0,0.5)]
            "
          >
            {/* GLOW */}
            <div className="absolute -top-40 -right-40 w-[500px] h-[500px] bg-[#98FF98]/10 rounded-full blur-[120px]" />

            <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] bg-[#0B3D91]/20 rounded-full blur-[120px]" />

            {/* WINDOW BAR */}
            <div className="h-16 border-b border-white/10 flex items-center px-6 bg-black/20">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-400" />

                <div className="w-3 h-3 rounded-full bg-yellow-400" />

                <div className="w-3 h-3 rounded-full bg-green-400" />
              </div>

              <div className="mx-auto px-6 py-2 rounded-xl bg-white/5 text-sm text-gray-400">
                secure.kfive.internal
              </div>
            </div>

            {/* CONTENT */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-8 p-8">
              {/* SIDEBAR */}
              <div className="rounded-3xl bg-white/5 border border-white/10 p-6">
                <div className="text-2xl font-black mb-8">
                  Dashboard
                </div>

                <div className="space-y-4">
                  {[
                    "Workspace",
                    "Documents",
                    "Code Studio",
                    "Communications",
                    "Infrastructure",
                  ].map((item, index) => (
                    <div
                      key={item}
                      className={`p-4 rounded-2xl transition cursor-pointer ${index === 0
                          ? "bg-[#0B3D91] text-white"
                          : "hover:bg-white/5 text-gray-400"
                        }`}
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>

              {/* MAIN GRID */}
              <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-6">
                {[
                  {
                    icon: LayoutDashboard,
                    title: "Analytics",
                  },

                  {
                    icon: FileText,
                    title: "Documents",
                  },

                  {
                    icon: Code,
                    title: "Development",
                  },

                  {
                    icon: Users,
                    title: "Collaboration",
                  },

                  {
                    icon: HardDrive,
                    title: "Infrastructure",
                  },

                  {
                    icon: Lock,
                    title: "Security",
                  },
                ].map((card, i) => (
                  <motion.div
                    key={i}
                    whileHover={{
                      y: -8,
                    }}
                    className="
                      group
                      relative
                      overflow-hidden
                      rounded-[32px]
                      border
                      border-white/10
                      bg-white/[0.03]
                      backdrop-blur-2xl
                      p-8
                      hover:border-[#98FF98]/30
                      transition-all
                      duration-500
                    "
                  >
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition duration-500 bg-gradient-to-br from-[#98FF98]/10 via-transparent to-[#0B3D91]/10" />

                    <card.icon className="w-10 h-10 text-[#98FF98] relative z-10" />

                    <h3 className="mt-8 text-2xl font-black relative z-10">
                      {card.title}
                    </h3>

                    <p className="mt-4 text-gray-400 relative z-10">
                      Enterprise operational systems with
                      advanced infrastructure tooling.
                    </p>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        </section>

        {/* FOOTER */}
        <footer className="border-t border-white/10 mt-20">
          <div className="max-w-7xl mx-auto px-6 py-20 grid grid-cols-1 md:grid-cols-4 gap-12">
            <div>
              <h3 className="text-3xl font-black">
                KFive
              </h3>

              <p className="mt-6 text-gray-400 leading-relaxed">
                Enterprise workspace infrastructure platform
                engineered for modern organizations.
              </p>
            </div>

            <div>
              <h4 className="font-bold mb-6">
                Platform
              </h4>

              <div className="space-y-4 text-gray-400">
                <div>Workspace</div>
                <div>IDE Systems</div>
                <div>Documents</div>
                <div>Infrastructure</div>
              </div>
            </div>

            <div>
              <h4 className="font-bold mb-6">
                Security
              </h4>

              <div className="space-y-4 text-gray-400">
                <div>Encryption</div>
                <div>Compliance</div>
                <div>Monitoring</div>
                <div>Architecture</div>
              </div>
            </div>

            <div>
              <h4 className="font-bold mb-6">
                Company
              </h4>

              <div className="space-y-4 text-gray-400">
                <div>About</div>
                <div>Careers</div>
                <div>Contact</div>
                <div>Infrastructure</div>
              </div>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}