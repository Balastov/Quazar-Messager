// Первым: crypto.getRandomValues из системного генератора — на нём ключи и nonce E2E.
import 'react-native-get-random-values';
import {AppRegistry} from 'react-native';
import App from './src/App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
