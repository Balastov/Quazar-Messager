import React, {useEffect, useState} from 'react';
import {AppState, Modal, Pressable, ScrollView, Text, View} from 'react-native';
import {useAuthStore} from '../store/auth';
import {phoneVerificationApi} from '../api/phoneVerification';
import PhoneVerification from './PhoneVerification';

export default function PhoneVerificationPrompt() {
  const user = useAuthStore(st => st.user), authDue = useAuthStore(st => st.phonePromptPending);
  const hydrated = useAuthStore(st => st.hydrated);
  const [weeklyDue, setWeeklyDue] = useState(false), [proof, setProof] = useState<string>();
  useEffect(() => {
    setWeeklyDue(false); setProof(undefined);
    if (!hydrated || !user || user.phone_verified_at) {return;}
    let active = true, inFlight = false, timer: ReturnType<typeof setTimeout>;
    let loginPromptUnclaimed = useAuthStore.getState().phonePromptPending;
    const check = () => {
      if (!active || inFlight) {return;}
      inFlight = true; clearTimeout(timer);
      const authShown = loginPromptUnclaimed || useAuthStore.getState().phonePromptPending;
      void phoneVerificationApi.reminder().then(result => {
        if (!active) {return;}
        loginPromptUnclaimed = false;
        if (result.due && !authShown) {setWeeklyDue(true);}
        timer = setTimeout(check, Math.max(1000, Date.parse(result.next_at) - Date.parse(result.server_time) + 1000));
      }).catch(() => {if (active) {timer = setTimeout(check, 60_000);}}).finally(() => {inFlight = false;});
    };
    check();
    const sub = AppState.addEventListener('change', value => {if (value === 'active') {check();}});
    return () => {active = false; clearTimeout(timer); sub.remove();};
  }, [user?.id, user?.phone_verified_at, hydrated]);
  if (!hydrated || !user || user.phone_verified_at || user.phone_discoverable === null || (!authDue && !weeklyDue)) {return null;}
  const close = () => {useAuthStore.getState().dismissPhonePrompt(); setWeeklyDue(false);};
  return <Modal transparent visible animationType="fade" onRequestClose={close}>
    <ScrollView style={{backgroundColor: 'rgba(4,3,12,0.85)'}} contentContainerStyle={{flexGrow: 1, justifyContent: 'center', padding: 20}}>
      <View style={{backgroundColor: '#161028', borderRadius: 18, padding: 20, gap: 14}}>
        <Text style={{color: '#f4f1ff', fontSize: 20}}>Подтвердите телефон</Text>
        <Text style={{color: '#9b93b8'}}>Подтвердите, что номер принадлежит вам. Это поможет защитить аккаунт и позволит входить без пароля.</Text>
        <PhoneVerification phone={user.phone!} account proof={proof} onVerified={setProof} />
        <Pressable onPress={close}><Text style={{color: '#9b93b8'}}>Напомнить позже</Text></Pressable>
      </View>
    </ScrollView>
  </Modal>;
}
