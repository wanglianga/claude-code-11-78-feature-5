import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/auth';
import Layout from './ui/Layout';
import LoginPage from './ui/pages/LoginPage';
import LoaderPage from './ui/pages/LoaderPage';
import AlignmentPage from './ui/pages/AlignmentPage';
import RulesPage from './ui/pages/RulesPage';
import VerificationPage from './ui/pages/VerificationPage';
import EventsPage from './ui/pages/EventsPage';
import EventDetailPage from './ui/pages/EventDetailPage';
import EvidencePage from './ui/pages/EvidencePage';
import DisposalPage from './ui/pages/DisposalPage';
import SyncPage from './ui/pages/SyncPage';
import SelfCheckPage from './ui/pages/SelfCheckPage';
import SafetyPage from './ui/pages/SafetyPage';

export default function App() {
  const { user } = useAuth();
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/loader" replace />} />
        <Route path="/loader" element={<LoaderPage />} />
        <Route path="/alignment" element={<AlignmentPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/verification" element={<VerificationPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:route/:id" element={<EventDetailPage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="/disposal" element={<DisposalPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/selfcheck" element={<SelfCheckPage />} />
        <Route path="/safety" element={<SafetyPage />} />
        <Route path="*" element={<Navigate to="/loader" replace />} />
      </Route>
    </Routes>
  );
}
