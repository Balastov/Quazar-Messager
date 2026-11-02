import React, {useEffect, useState} from 'react';
import {Text, TextInput, View} from 'react-native';
import {useAuthStore} from '../store/auth';
import type {AccountProof} from '../crypto/keys';
import PhoneVerification from './PhoneVerification';

export default function AccountProofInput({onChange, disabled}: {onChange: (proof: AccountProof | null) => void; disabled?: boolean}) {
  const user = useAuthStore(st => st.user);
  const [proof, setProof] = useState<string>();
  useEffect(() => {onChange(null);}, [user?.phone_verified_at]);
  if (user?.phone_verified_at) return <View>
    <Text style={{color: '#9b93b8'}}>Подтвердите важное действие свежим звонком.</Text>
    <PhoneVerification phone={user.phone!} account="reauth" proof={proof} onVerified={token => {setProof(token); onChange({phoneProof: token});}} />
  </View>;
  if (user?.has_password === false) return <Text style={{color: '#9b93b8'}}>Сначала подтвердите телефон в профиле, чтобы подтверждать важные действия звонком.</Text>;
  return <TextInput placeholder="Пароль аккаунта" placeholderTextColor="#888" secureTextEntry editable={!disabled} autoCapitalize="none"
    style={{backgroundColor: '#1a1d27', color: '#f4f1ff', padding: 12, borderRadius: 10, marginVertical: 10}}
    onChangeText={value => onChange(value.length >= 8 ? value : null)} />;
}
