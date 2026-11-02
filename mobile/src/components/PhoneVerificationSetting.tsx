import React, {useEffect, useState} from 'react';
import {Text, View} from 'react-native';
import {authApi} from '../api/auth';
import {usersApi} from '../api/users';
import {useAuthStore} from '../store/auth';
import PhoneVerification from './PhoneVerification';

export default function PhoneVerificationSetting() {
  const user = useAuthStore(st => st.user);
  const [enabled, setEnabled] = useState(false), [proof, setProof] = useState<string>();
  useEffect(() => {void authApi.providers().then(p => setEnabled(!!p.phone_verification)).catch(() => {});}, []);
  if (!user || !enabled) {return null;}
  return <View style={{padding: 16, gap: 10, marginBottom: 12}}>
    <Text style={{color: '#f4f1ff', fontWeight: '600'}}>Подтверждение телефона</Text>
    {user.phone_verified_at ? <Text style={{color: '#34d399'}}>✓ Телефон подтверждён</Text> : <PhoneVerification
      phone={user.phone!} account proof={proof} onVerified={token => {
        setProof(token); void usersApi.me().then(me => useAuthStore.getState().setUser(me)).catch(() => {});
      }} />}
  </View>;
}
