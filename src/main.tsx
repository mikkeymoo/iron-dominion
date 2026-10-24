import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { UpdateToast } from './ui/PwaUi';
import { startPwa } from './platform/pwa';
startPwa();
createRoot(document.getElementById('root')!).render(<><App/><UpdateToast/></>);
