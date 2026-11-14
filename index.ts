import { registerRootComponent } from 'expo';

// Defines the background location task. Must be imported before anything else runs,
// because Android can start the JS runtime headless just to deliver locations.
import './src/tracking';
import App from './App';

registerRootComponent(App);
